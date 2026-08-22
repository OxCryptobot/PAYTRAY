import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const MIN_ATTEMPTS = 2
const MAX_ATTEMPTS = 16
const MIN_REPETITIONS = 1
const MAX_REPETITIONS = 10

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

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  return value
}

let databaseIsolation = false

function requiredIsolation() {
  if (process.env.MIGRATION_018_CONCURRENCY_ISOLATED !== 'true') throw new Error('MIGRATION_018_CONCURRENCY_ISOLATED=true is required')
  const value = process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL is required')
  const url = new URL(value)
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/(ci|test|testing|disposable|recovery)/.test(databaseName)) {
    throw new Error('migration-018 concurrency verifier requires a local disposable database URL')
  }
  databaseIsolation = true
  return value
}

function insertParams(runId) {
  return [
    runId,
    false,
    SAFE_REPORT.status,
    SAFE_REPORT.checkCount,
    SAFE_REPORT.passedCount,
    SAFE_REPORT.operatorBlockerCount,
    SAFE_REPORT.unexpectedFailureCount,
    JSON.stringify(SAFE_REPORT),
    reportHash(SAFE_REPORT),
    '2026-08-17T00:00:00.000Z',
    '2026-08-17T00:01:00.000Z'
  ]
}

async function runRace(pool, attempts) {
  const runId = randomUUID()
  const statement = `
    INSERT INTO operations_quality_runs (
      run_id, strict_mode, status, check_count, passed_count,
      operator_blocker_count, unexpected_failure_count, report,
      report_hash, started_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
    RETURNING run_id
  `
  const started = performance.now()
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    const attemptStarted = performance.now()
    try {
      const result = await pool.query(statement, insertParams(runId))
      return { status: 'committed', commitPerformed: true, sqlState: null, runId: result.rows[0].run_id, elapsedMs: Math.round((performance.now() - attemptStarted) * 100) / 100 }
    } catch (error) {
      return { status: 'rejected', commitPerformed: false, sqlState: error.code ?? null, error: error.message, elapsedMs: Math.round((performance.now() - attemptStarted) * 100) / 100 }
    }
  }))
  const persisted = (await pool.query(`
    SELECT strict_mode, status, check_count, passed_count, operator_blocker_count,
           unexpected_failure_count, report, report_hash
      FROM operations_quality_runs
     WHERE run_id = $1
  `, [runId])).rows[0]
  if (!persisted) throw new Error('migration-018 winning operations-quality row was not persisted')
  if (persisted.strict_mode !== false || persisted.status !== SAFE_REPORT.status || persisted.check_count !== SAFE_REPORT.checkCount || persisted.passed_count !== SAFE_REPORT.passedCount || persisted.operator_blocker_count !== SAFE_REPORT.operatorBlockerCount || persisted.unexpected_failure_count !== SAFE_REPORT.unexpectedFailureCount) throw new Error('migration-018 persisted operations-quality counters or strict mode drifted')
  if (persisted.report_hash !== reportHash(SAFE_REPORT)) throw new Error('migration-018 persisted report hash does not match canonical report')
  for (const [field, expected] of Object.entries({ releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })) {
    if (persisted.report?.[field] !== expected) throw new Error(`migration-018 persisted report safety field ${field} drifted`)
  }
  const rowCount = Number((await pool.query('SELECT COUNT(*)::int AS count FROM operations_quality_runs WHERE run_id = $1', [runId])).rows[0].count)
  const winners = outcomes.filter((outcome) => outcome.status === 'committed').length
  const duplicateRejects = outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.sqlState === '23505').length
  const unexpectedRejects = outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.sqlState !== '23505').length
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100
  return {
    runId,
    attempts,
    winners,
    duplicateRejects,
    unexpectedRejects,
    rowCount,
    elapsedMs,
    persistedSafety: {
      strictMode: persisted.strict_mode,
      status: persisted.status,
      reportHashMatches: true,
      releaseEligible: persisted.report.releaseEligible,
      settlementAuthority: persisted.report.settlementAuthority,
      mutation: persisted.report.mutation,
      deploymentPerformed: persisted.report.deploymentPerformed,
      settlementMutationPerformed: persisted.report.settlementMutationPerformed
    },
    outcomes
  }
}

async function main() {
  const connectionString = requiredIsolation()
  const attempts = boundedInteger('MIGRATION_018_CONCURRENCY_ATTEMPTS', 8, MIN_ATTEMPTS, MAX_ATTEMPTS)
  const repetitions = boundedInteger('MIGRATION_018_CONCURRENCY_REPETITIONS', 3, MIN_REPETITIONS, MAX_REPETITIONS)
  const pool = new Pool({ connectionString, max: attempts + 2, connectionTimeoutMillis: 5000 })
  const runs = []
  try {
    for (let index = 0; index < repetitions; index += 1) runs.push(await runRace(pool, attempts))
  } finally {
    if (runs.length) await pool.query('DELETE FROM operations_quality_runs WHERE run_id = ANY($1::uuid[])', [runs.map((run) => run.runId)])
    await pool.end()
  }

  const validRuns = runs.filter((run) => run.winners === 1 && run.duplicateRejects === attempts - 1 && run.unexpectedRejects === 0 && run.rowCount === 1)
  const valid = validRuns.length === repetitions
  console.log(JSON.stringify({
    status: valid ? 'verified' : 'blocked',
    migration: '018_operations_quality_runs',
    concurrency: { attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: validRuns.length },
    runs,
    cleanupRuns: runs.length,
    databaseIsolation: true,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    valid
  }, null, 2))
  if (!valid) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    migration: '018_operations_quality_runs',
    databaseIsolation,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
