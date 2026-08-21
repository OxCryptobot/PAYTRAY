import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '008_production_telemetry'
const DATABASE_URL = process.env.MIGRATION_008_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_008_CONTRACT_ISOLATED === 'true'

function json(value) { return JSON.stringify(value, null, 2) }

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_008_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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

async function verifyCatalog(client) {
  const columns = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'production_telemetry_events'
     ORDER BY ordinal_position
  `)
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    'id', 'event_id', 'event_type', 'occurred_at', 'received_at', 'actor_scope',
    'entity_type', 'entity_id', 'correlation_id', 'schema_version', 'source',
    'privacy_class', 'payload', 'payload_hash', 'provenance', 'created_at'
  ])

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'production_telemetry_events'
       AND indexname IN ('production_telemetry_type_time_index', 'production_telemetry_entity_index', 'production_telemetry_lag_index')
     ORDER BY indexname
  `)
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'production_telemetry_entity_index',
    'production_telemetry_lag_index',
    'production_telemetry_type_time_index'
  ])

  const checks = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.production_telemetry_events'::regclass AND contype = 'c'
     ORDER BY conname
  `)
  assert.equal(checks.rows.length, 2)
  assert.ok(checks.rows.some((row) => /event_type/i.test(row.definition) && /discovery_impression/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => /privacy_class/i.test(row.definition) && /operational/i.test(row.definition)))
  return { status: 'passed', columnCount: columns.rows.length, indexes: indexes.rows.map((row) => row.indexname), checkCount: checks.rows.length }
}

async function insertEvent(client, eventId, eventType = 'discovery_impression', privacyClass = 'derived_non_content') {
  return client.query(`
    INSERT INTO production_telemetry_events (
      event_id, event_type, occurred_at, actor_scope, entity_type, entity_id,
      schema_version, source, privacy_class, payload_hash
    ) VALUES ($1, $2, '2026-08-20T00:00:00.000Z', 'platform', 'profile', 'profile-008', 'v1', 'verifier-008', $3, $4)
    RETURNING id, event_id, payload, provenance
  `, [eventId, eventType, privacyClass, 'd'.repeat(64)])
}

async function eventRace(pool, eventId, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertEvent(client, eventId))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one duplicate telemetry event writer must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining duplicate telemetry event writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'every duplicate telemetry event loser must return SQLSTATE 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const eventIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const eventId = `migration008-event-${Date.now()}-${Math.random().toString(16).slice(2)}`
    eventIds.push(eventId)
    const valid = await withTransaction(pool, (client) => insertEvent(client, eventId))
    assert.deepEqual(valid.rows[0].payload, {})
    assert.deepEqual(valid.rows[0].provenance, {})
    const duplicate = await expectSqlState(pool, 'duplicate telemetry event id', '23505', (client) => insertEvent(client, eventId))
    const invalidEventType = await expectSqlState(pool, 'invalid telemetry event type', '23514', (client) => insertEvent(client, `invalid-type-${Date.now()}`, 'unknown_event'))
    const invalidPrivacyClass = await expectSqlState(pool, 'invalid telemetry privacy class', '23514', (client) => insertEvent(client, `invalid-privacy-${Date.now()}`, 'discovery_impression', 'raw_content'))

    const raceRuns = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const raceEventId = `migration008-race-${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`
      eventIds.push(raceEventId)
      raceRuns.push(await eventRace(pool, raceEventId, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        defaults: { status: 'passed', payload: {}, provenance: {} },
        duplicateEventId: duplicate,
        invalidEventType,
        invalidPrivacyClass,
        concurrentDuplicateEventId: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: raceRuns.length, runs: raceRuns }
      },
      cleanupEventIds: eventIds.length
    }
  } finally {
    await withTransaction(pool, (client) => client.query('DELETE FROM production_telemetry_events WHERE event_id = ANY($1::varchar[])', [eventIds]))
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_008_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_008_CONCURRENCY_ATTEMPTS', 8, 2, 16)
  const repetitions = boundedInteger('MIGRATION_008_CONCURRENCY_REPETITIONS', 3, 1, 10)
  const pool = new Pool({ connectionString: DATABASE_URL, max: attempts + 2, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool, attempts, repetitions)
    console.log(json({ ...report, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
