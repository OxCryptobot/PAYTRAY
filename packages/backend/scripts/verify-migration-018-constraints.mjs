import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const SAFE_REPORT = {
  reportKind: 'operations_quality',
  strict: false,
  status: 'operator_blocked',
  checkCount: 1,
  passedCount: 0,
  operatorBlockerCount: 1,
  unexpectedFailureCount: 0,
  checks: [{ name: 'fixture', state: 'operator_blocked', exitCode: 1, status: 'blocked', expectedBlocked: true, reason: 'disposable fixture', authority: 'test', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }],
  operatorBlockers: [{ name: 'fixture', status: 'blocked', reason: 'disposable fixture' }],
  unexpectedFailures: [],
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  generatedAt: '2026-08-17T00:00:00.000Z'
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => ({ ...result, [key]: canonicalize(value[key]) }), {})
  return value
}

function reportHash(report) {
  return createHash('sha256').update(JSON.stringify(canonicalize(report)), 'utf8').digest('hex')
}

function requiredIsolation() {
  if (process.env.MIGRATION_018_CONTRACT_ISOLATED !== 'true') throw new Error('MIGRATION_018_CONTRACT_ISOLATED=true is required')
  const value = process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL is required')
  const url = new URL(value)
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/(ci|test|testing|disposable|recovery)/.test(databaseName)) {
    throw new Error('migration-018 verifier requires a local disposable database URL')
  }
  return value
}

async function expectSqlState(pool, label, statement, params, sqlState) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let error = null
    try {
      await client.query(statement, params)
    } catch (caught) {
      error = caught
    }
    await client.query('ROLLBACK')
    if (!error) throw new Error(`${label} did not fail`)
    if (error.code !== sqlState) throw new Error(`${label} expected SQLSTATE ${sqlState}, received ${error.code}`)
    return { status: 'passed', sqlState }
  } finally {
    client.release()
  }
}

function rowParams({ runId, report = SAFE_REPORT, reportHashValue = reportHash(report), overrides = {} } = {}) {
  return [
    runId,
    false,
    report.status,
    report.checkCount,
    report.passedCount,
    report.operatorBlockerCount,
    report.unexpectedFailureCount,
    JSON.stringify(report),
    reportHashValue,
    '2026-08-17T00:00:00.000Z',
    '2026-08-17T00:01:00.000Z',
    ...[]
  ].map((value, index) => overrides[index] === undefined ? value : overrides[index])
}

async function main() {
  const connectionString = requiredIsolation()
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 })
  const fixtureRunIds = []
  const cases = {}
  try {
    const catalog = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'operations_quality_runs'
        AND indexname = ANY($1::text[])
      ORDER BY indexname
    `, [['operations_quality_runs_created_index', 'operations_quality_runs_status_index']])
    if (catalog.rows.map((row) => row.indexname).join(',') !== 'operations_quality_runs_created_index,operations_quality_runs_status_index') {
      throw new Error('migration-018 expected indexes are missing')
    }
    cases.catalog = { status: 'passed', indexes: catalog.rows.map((row) => row.indexname) }

    const validRunId = randomUUID()
    fixtureRunIds.push(validRunId)
    const validInsert = await pool.query(`
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
      RETURNING run_id, report_hash, report
    `, rowParams({ runId: validRunId }))
    if (validInsert.rows[0].report_hash !== reportHash(SAFE_REPORT) || validInsert.rows[0].report.releaseEligible !== false || validInsert.rows[0].report.mutation !== 'read_only') {
      throw new Error('migration-018 valid report did not persist canonical safety data')
    }
    cases.validReport = { status: 'passed', reportHash: validInsert.rows[0].report_hash }

    const invalidStatusId = randomUUID()
    fixtureRunIds.push(invalidStatusId)
    cases.invalidStatus = await expectSqlState(pool, 'invalid status', `
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, false, 'operator_pending', 1, 0, 1, 0, $2::jsonb, $3, $4, $5)
    `, [invalidStatusId, JSON.stringify(SAFE_REPORT), reportHash(SAFE_REPORT), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23514')

    const negativeCountId = randomUUID()
    fixtureRunIds.push(negativeCountId)
    cases.negativeCount = await expectSqlState(pool, 'negative check count', `
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, false, 'passed', -1, 0, 0, 0, $2::jsonb, $3, $4, $5)
    `, [negativeCountId, JSON.stringify(SAFE_REPORT), reportHash(SAFE_REPORT), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23514')

    const mismatchedCountId = randomUUID()
    fixtureRunIds.push(mismatchedCountId)
    cases.countReconciliation = await expectSqlState(pool, 'count reconciliation', `
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, false, 'operator_blocked', 2, 0, 1, 0, $2::jsonb, $3, $4, $5)
    `, [mismatchedCountId, JSON.stringify(SAFE_REPORT), reportHash(SAFE_REPORT), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23514')

    cases.immutableReports = {}
    for (const field of ['releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed', 'mutation']) {
      const unsafeReport = { ...SAFE_REPORT, [field]: field === 'mutation' ? 'execute' : true }
      const unsafeId = randomUUID()
      fixtureRunIds.push(unsafeId)
      cases.immutableReports[field] = await expectSqlState(pool, `unsafe report ${field}`, `
        INSERT INTO operations_quality_runs (
          run_id, strict_mode, status, check_count, passed_count,
          operator_blocker_count, unexpected_failure_count, report,
          report_hash, started_at, completed_at
        ) VALUES ($1, false, 'operator_blocked', 1, 0, 1, 0, $2::jsonb, $3, $4, $5)
      `, [unsafeId, JSON.stringify(unsafeReport), reportHash(unsafeReport), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23514')
    }

    const invalidHashId = randomUUID()
    fixtureRunIds.push(invalidHashId)
    cases.invalidReportHash = await expectSqlState(pool, 'invalid report hash', `
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, false, 'operator_blocked', 1, 0, 1, 0, $2::jsonb, 'not-a-hash', $3, $4)
    `, [invalidHashId, JSON.stringify(SAFE_REPORT), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23514')

    cases.duplicateRunId = await expectSqlState(pool, 'duplicate run id', `
      INSERT INTO operations_quality_runs (
        run_id, strict_mode, status, check_count, passed_count,
        operator_blocker_count, unexpected_failure_count, report,
        report_hash, started_at, completed_at
      ) VALUES ($1, false, 'operator_blocked', 1, 0, 1, 0, $2::jsonb, $3, $4, $5)
    `, [validRunId, JSON.stringify(SAFE_REPORT), reportHash(SAFE_REPORT), '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z'], '23505')
  } finally {
    if (fixtureRunIds.length > 0) await pool.query('DELETE FROM operations_quality_runs WHERE run_id = ANY($1::uuid[])', [fixtureRunIds])
    await pool.end()
  }

  console.log(JSON.stringify({
    status: 'verified',
    migration: '018_operations_quality_runs',
    cases,
    cleanupRuns: fixtureRunIds.length,
    databaseIsolation: true,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    migration: '018_operations_quality_runs',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
