import crypto from 'node:crypto'

const SAFE_STATES = new Set(['passed', 'operator_blocked', 'failed'])

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key])
      return result
    }, {})
  }
  return value
}

function reportHash(report) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(report)), 'utf8').digest('hex')
}

function safeCheck(check = {}) {
  return {
    name: String(check.name || 'unknown'),
    state: String(check.state || 'failed'),
    exitCode: Number.isInteger(check.exitCode) ? check.exitCode : null,
    status: String(check.status || 'unparseable'),
    expectedBlocked: check.expectedBlocked === true,
    reason: String(check.reason || '').slice(0, 500),
    authority: check.authority || null,
    releaseEligible: check.releaseEligible === true,
    settlementAuthority: check.settlementAuthority === true,
    mutation: check.mutation || null
  }
}

export function buildOperationsQualityAuditRecord({ report, runId, startedAt, completedAt } = {}) {
  if (!report || typeof report !== 'object') throw new TypeError('operations quality report is required')
  if (!runId) throw new TypeError('operations quality runId is required')
  const status = String(report.status || '')
  if (!SAFE_STATES.has(status)) throw new TypeError('operations quality report status is invalid')
  const checks = Array.isArray(report.checks) ? report.checks.map(safeCheck) : []
  const safeReport = {
    status,
    reportKind: String(report.reportKind || 'operations_quality'),
    strict: report.strict === true,
    checkCount: Number(report.checkCount || checks.length),
    passedCount: Number(report.passedCount || 0),
    operatorBlockerCount: Number(report.operatorBlockerCount || 0),
    unexpectedFailureCount: Number(report.unexpectedFailureCount || 0),
    checks,
    operatorBlockers: Array.isArray(report.operatorBlockers) ? report.operatorBlockers.map(({ name, status: checkStatus, reason }) => ({ name, status: checkStatus, reason })) : [],
    unexpectedFailures: Array.isArray(report.unexpectedFailures) ? report.unexpectedFailures.map(({ name, status: checkStatus, reason }) => ({ name, status: checkStatus, reason })) : [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    generatedAt: report.generatedAt || completedAt || new Date().toISOString()
  }
  return {
    runId: String(runId),
    strictMode: safeReport.strict,
    status,
    checkCount: safeReport.checkCount,
    passedCount: safeReport.passedCount,
    operatorBlockerCount: safeReport.operatorBlockerCount,
    unexpectedFailureCount: safeReport.unexpectedFailureCount,
    report: safeReport,
    reportHash: reportHash(safeReport),
    startedAt: new Date(startedAt || safeReport.generatedAt).toISOString(),
    completedAt: new Date(completedAt || safeReport.generatedAt).toISOString(),
    authority: 'operations_quality_audit',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function recordOperationsQualityRun({ client, report, runId, startedAt, completedAt } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client is required')
  const record = buildOperationsQualityAuditRecord({ report, runId, startedAt, completedAt })
  const result = await client.query(
    `INSERT INTO operations_quality_runs (
      run_id, strict_mode, status, check_count, passed_count,
      operator_blocker_count, unexpected_failure_count, report,
      report_hash, started_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
    ON CONFLICT (run_id) DO NOTHING
    RETURNING *`,
    [record.runId, record.strictMode, record.status, record.checkCount, record.passedCount, record.operatorBlockerCount, record.unexpectedFailureCount, JSON.stringify(record.report), record.reportHash, record.startedAt, record.completedAt]
  )
  return {
    record: result.rows[0] || null,
    idempotentReplay: !result.rows[0],
    runId: record.runId,
    reportHash: record.reportHash,
    authority: record.authority,
    mutation: record.mutation,
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function getOperationsQualityRun({ client, runId } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client is required')
  const normalizedRunId = String(runId || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedRunId)) {
    throw new TypeError('runId must be a valid UUID')
  }
  const result = await client.query(
    `SELECT id, run_id, strict_mode, status, check_count, passed_count,
            operator_blocker_count, unexpected_failure_count, report,
            report_hash, started_at, completed_at, created_at
     FROM operations_quality_runs
     WHERE run_id = $1`,
    [normalizedRunId]
  )
  if (!result.rows[0]) return null
  return {
    status: 'ok',
    run: result.rows[0],
    authority: 'operations_quality_audit',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function getLatestReleaseGatesRun({ client } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client is required')
  const result = await client.query(
    `SELECT id, run_id, strict_mode, status, check_count, passed_count,
            operator_blocker_count, unexpected_failure_count, report,
            report_hash, started_at, completed_at, created_at
     FROM operations_quality_runs
     WHERE report->>'reportKind' = 'release_gates'
     ORDER BY created_at DESC
     LIMIT 1`
  )
  if (!result.rows[0]) {
    return {
      status: 'not_recorded',
      reason: 'no durable release-gate matrix run is available',
      run: null,
      authority: 'operations_quality_audit',
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }
  }
  return {
    status: 'ok',
    run: result.rows[0],
    authority: 'operations_quality_audit',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function listOperationsQualityRuns({ client, limit = 50, status = null } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client is required')
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const normalizedStatus = status && SAFE_STATES.has(String(status)) ? String(status) : null
  const result = await client.query(
    `SELECT id, run_id, strict_mode, status, check_count, passed_count,
            operator_blocker_count, unexpected_failure_count, report_hash,
            started_at, completed_at, created_at
     FROM operations_quality_runs
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [normalizedStatus, boundedLimit]
  )
  return {
    status: 'ok',
    runs: result.rows,
    count: result.rows.length,
    authority: 'operations_quality_audit',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { canonicalize, reportHash, safeCheck, SAFE_STATES }
