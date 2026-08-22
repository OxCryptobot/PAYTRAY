import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_014_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_014_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_014_CONTRACT_DATABASE_URL or DATABASE_URL is required')
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('database URL must be a valid URL') }
  const databaseName = parsed.pathname.replace(/^\//, '')
  const safeHost = ['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.hostname.endsWith('.test')
  const safeName = /(?:^|[_-])(ci|test|testing|disposable)(?:$|[_-])/i.test(databaseName)
  if (!safeHost || !safeName) throw new Error('database target must be a local/test/disposable PostgreSQL database; refusing non-disposable target')
}

async function withTransaction(pool, callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function expectSqlState(pool, name, expectedSqlState, callback) {
  let error = null
  try {
    await withTransaction(pool, callback)
    assert.fail(`${name}: expected PostgreSQL SQLSTATE ${expectedSqlState}`)
  } catch (caught) {
    error = caught
  }
  assert.equal(error?.code, expectedSqlState, `${name}: unexpected SQLSTATE or assertion failure: ${error?.message}`)
  return { status: 'passed', sqlState: expectedSqlState }
}

function timestamps(offsetMinutes = 5) {
  return {
    createdAt: '2026-08-20T00:00:00.000Z',
    expiresAt: `2026-08-20T00:${String(offsetMinutes).padStart(2, '0')}:00.000Z`
  }
}

async function insertClaim(client, replayKey, expiresAt, createdAt = '2026-08-20T00:00:00.000Z') {
  await client.query(`
    INSERT INTO webhook_replay_claims (replay_key, expires_at, created_at)
    VALUES ($1, $2, $3)
  `, [replayKey, expiresAt, createdAt])
}

async function atomicClaim(pool, replayKey, expiresAt, now) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(`
      INSERT INTO webhook_replay_claims (replay_key, expires_at)
      VALUES ($1, $2)
      ON CONFLICT (replay_key) DO UPDATE
        SET expires_at = EXCLUDED.expires_at
       WHERE webhook_replay_claims.expires_at <= $3
      RETURNING replay_key
    `, [replayKey, expiresAt, now])
    return result.rows[0] || null
  })
}

async function verifyCatalog(client) {
  const columns = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'webhook_replay_claims'
     ORDER BY ordinal_position
  `)
  assert.deepEqual(columns.rows.map((row) => row.column_name), ['replay_key', 'expires_at', 'created_at'])

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'webhook_replay_claims'
     ORDER BY indexname
  `)
  assert.ok(indexes.rows.some((row) => row.indexname === 'webhook_replay_claims_pkey'))
  assert.ok(indexes.rows.some((row) => row.indexname === 'webhook_replay_claims_expiry_index'))
  return { status: 'passed', columns: columns.rows.map((row) => row.column_name), indexes: indexes.rows.map((row) => row.indexname) }
}

async function replayClaimRace(pool, replayKey, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, () => atomicClaim(pool, replayKey, '2026-08-20T00:15:00.000Z', '2026-08-20T00:00:00.000Z')))
  const winners = outcomes.filter(Boolean)
  const losers = outcomes.filter((outcome) => outcome === null)
  assert.equal(winners.length, 1, 'exactly one concurrent replay claimant must win')
  assert.equal(losers.length, attempts - 1, 'all remaining replay claimants must observe a duplicate')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length }
}

async function runContractSuite(pool, attempts, repetitions) {
  const keys = new Set()
  const results = {}
  try {
    results.catalog = await withTransaction(pool, (client) => verifyCatalog(client))

    const nullKey = `migration-014:null:${randomUUID()}`
    keys.add(nullKey)
    results.nullReplayKey = await expectSqlState(pool, 'null replay key', '23502', (client) => insertClaim(client, null, timestamps().expiresAt))

    const duplicateKey = `migration-014:duplicate:${randomUUID()}`
    keys.add(duplicateKey)
    await withTransaction(pool, (client) => insertClaim(client, duplicateKey, timestamps().expiresAt))
    results.duplicateReplayKey = await expectSqlState(pool, 'duplicate replay key', '23505', (client) => insertClaim(client, duplicateKey, timestamps(10).expiresAt))

    const expiredKey = `migration-014:expired:${randomUUID()}`
    keys.add(expiredKey)
    await withTransaction(pool, (client) => insertClaim(client, expiredKey, '2026-08-20T00:01:00.000Z'))
    const refreshed = await atomicClaim(pool, expiredKey, '2026-08-20T00:10:00.000Z', '2026-08-20T00:05:00.000Z')
    assert.deepEqual(refreshed, { replay_key: expiredKey })
    results.expiredReplacement = { status: 'passed', replaced: true }

    const runs = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const raceKey = `migration-014:race:${randomUUID()}`
      keys.add(raceKey)
      runs.push(await replayClaimRace(pool, raceKey, attempts))
    }
    results.concurrentClaim = { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: runs.length, runs }

    return { status: 'verified', cases: results, cleanupKeys: keys.size }
  } finally {
    const values = [...keys]
    await withTransaction(pool, (client) => client.query('DELETE FROM webhook_replay_claims WHERE replay_key = ANY($1::varchar[])', [values]))
  }
}

async function main() {
  let pool = null
  try {
    if (!ISOLATED) throw new Error('MIGRATION_014_CONTRACT_ISOLATED=true is required')
    assertDisposableDatabaseUrl(DATABASE_URL)
    const attempts = boundedInteger('MIGRATION_014_CONCURRENCY_ATTEMPTS', 8, 2, 16)
    const repetitions = boundedInteger('MIGRATION_014_CONCURRENCY_REPETITIONS', 3, 1, 10)
    pool = new Pool({ connectionString: DATABASE_URL, max: attempts + 2, min: 0, connectionTimeoutMillis: 5000 })
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool, attempts, repetitions)
    console.log(json({ ...report, migration: '014_webhook_replay_claims', databaseIsolation: true, cleanupPerformed: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: '014_webhook_replay_claims', databaseIsolation: false, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
    process.exitCode = 1
  } finally {
    await pool?.end()
  }
}

await main()
