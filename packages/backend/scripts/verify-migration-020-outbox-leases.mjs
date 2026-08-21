import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_020_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_020_CONTRACT_ISOLATED === 'true'
const MAX_ATTEMPTS = 5
const LEASE_MS = 120000
const RACE_ATTEMPTS = Number.parseInt(process.env.MIGRATION_020_RACE_ATTEMPTS || '4', 10)
const RACE_REPETITIONS = Number.parseInt(process.env.MIGRATION_020_RACE_REPETITIONS || '3', 10)

function json(value) {
  return JSON.stringify(value, null, 2)
}

function assertBounds() {
  if (!Number.isInteger(RACE_ATTEMPTS) || RACE_ATTEMPTS < 2 || RACE_ATTEMPTS > 8) throw new Error('MIGRATION_020_RACE_ATTEMPTS must be an integer between 2 and 8')
  if (!Number.isInteger(RACE_REPETITIONS) || RACE_REPETITIONS < 1 || RACE_REPETITIONS > 10) throw new Error('MIGRATION_020_RACE_REPETITIONS must be an integer between 1 and 10')
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentileIndex = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
  return {
    samples: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sorted.length === 0 ? 0 : Number((sorted.reduce((total, value) => total + value, 0) / sorted.length).toFixed(3)),
    p95Ms: sorted[percentileIndex] ?? 0
  }
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_020_CONTRACT_DATABASE_URL or DATABASE_URL is required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('database URL must be a valid URL')
  }
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

function fixture(seed = randomUUID()) {
  return {
    id: randomUUID(),
    aggregateId: randomUUID(),
    eventType: `migration_020.test.${seed.slice(0, 8)}`,
    correlationId: randomUUID()
  }
}

async function insertEvent(client, value, overrides = {}) {
  const event = { ...value, ...overrides }
  const result = await client.query(`
    INSERT INTO outbox_events (
      id, aggregate_type, aggregate_id, event_type, payload, correlation_id,
      occurred_at, available_at, processed_at, attempts, last_error,
      lease_token, lease_acquired_at, lease_expires_at, last_attempt_at, dead_lettered_at
    )
    VALUES ($1, 'migration_020', $2, $3, $4::jsonb, $5,
            CURRENT_TIMESTAMP, COALESCE($6::timestamp, CURRENT_TIMESTAMP), $7, $8, $9,
            $10, $11, $12, $13, $14)
    RETURNING id`, [
    event.id,
    event.aggregateId,
    event.eventType,
    JSON.stringify({ releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }),
    event.correlationId,
    event.availableAt || null,
    event.processedAt || null,
    event.attempts ?? 0,
    event.lastError || null,
    event.leaseToken || null,
    event.leaseAcquiredAt || null,
    event.leaseExpiresAt || null,
    event.lastAttemptAt || null,
    event.deadLetteredAt || null
  ])
  return result.rows[0]
}

async function verifyCatalog(client) {
  const columns = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'outbox_events'
       AND column_name = ANY($1::text[])
     ORDER BY column_name
  `, [['dead_lettered_at', 'last_attempt_at', 'lease_acquired_at', 'lease_expires_at', 'lease_token']])
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    'dead_lettered_at',
    'last_attempt_at',
    'lease_acquired_at',
    'lease_expires_at',
    'lease_token'
  ])

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'outbox_events'
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [['outbox_events_attempt_index', 'outbox_events_dead_letter_index', 'outbox_events_lease_expiry_index']])
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'outbox_events_attempt_index',
    'outbox_events_dead_letter_index',
    'outbox_events_lease_expiry_index'
  ])

  const constraints = await client.query(`
    SELECT constraint_name
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'outbox_events'
       AND constraint_name = ANY($1::text[])
     ORDER BY constraint_name
  `, [['outbox_events_attempt_timestamp_check', 'outbox_events_dead_letter_check', 'outbox_events_lease_shape_check', 'outbox_events_processed_lease_check']])
  assert.deepEqual(constraints.rows.map((row) => row.constraint_name), [
    'outbox_events_attempt_timestamp_check',
    'outbox_events_dead_letter_check',
    'outbox_events_lease_shape_check',
    'outbox_events_processed_lease_check'
  ])
  return {
    status: 'passed',
    columns: columns.rows.map((row) => row.column_name),
    indexes: indexes.rows.map((row) => row.indexname),
    constraints: constraints.rows.map((row) => row.constraint_name)
  }
}

async function claimOne(pool) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(`
      WITH picked AS (
        SELECT id
          FROM outbox_events
         WHERE processed_at IS NULL
           AND available_at <= CURRENT_TIMESTAMP
           AND attempts < $1
           AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
         ORDER BY available_at, occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE outbox_events event
         SET attempts = event.attempts + 1,
             last_attempt_at = CURRENT_TIMESTAMP,
             lease_token = uuid_generate_v4(),
             lease_acquired_at = CURRENT_TIMESTAMP,
             lease_expires_at = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'),
             available_at = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond')
        FROM picked
       WHERE event.id = picked.id
       RETURNING event.id, event.lease_token, event.attempts`, [MAX_ATTEMPTS, LEASE_MS])
    return result.rows[0] || null
  })
}

async function runContractSuite(pool) {
  const cleanupIds = new Set()
  const results = {}
  try {
    results.catalog = await withTransaction(pool, (client) => verifyCatalog(client))

    const leaseShape = fixture('lease-shape')
    cleanupIds.add(leaseShape.id)
    results.leaseShape = await expectSqlState(pool, 'lease token without timestamps', '23514', (client) => insertEvent(client, leaseShape, { leaseToken: randomUUID() }))

    const expiryOrder = fixture('expiry-order')
    cleanupIds.add(expiryOrder.id)
    results.expiryOrder = await expectSqlState(pool, 'lease expiry before acquisition', '23514', (client) => insertEvent(client, expiryOrder, {
      leaseToken: randomUUID(),
      leaseAcquiredAt: '2026-08-20T00:01:00.000Z',
      leaseExpiresAt: '2026-08-20T00:00:00.000Z'
    }))

    const processedLease = fixture('processed-lease')
    cleanupIds.add(processedLease.id)
    results.processedLease = await expectSqlState(pool, 'processed event retaining lease', '23514', (client) => insertEvent(client, processedLease, {
      processedAt: '2026-08-20T00:02:00.000Z',
      leaseToken: randomUUID(),
      leaseAcquiredAt: '2026-08-20T00:01:00.000Z',
      leaseExpiresAt: '2026-08-20T00:03:00.000Z'
    }))

    const deadWithoutAttempt = fixture('dead-without-attempt')
    cleanupIds.add(deadWithoutAttempt.id)
    results.deadWithoutAttempt = await expectSqlState(pool, 'dead letter without an attempt', '23514', (client) => insertEvent(client, deadWithoutAttempt, {
      deadLetteredAt: '2026-08-20T00:02:00.000Z'
    }))

    const attemptWithoutTimestamp = fixture('attempt-without-timestamp')
    cleanupIds.add(attemptWithoutTimestamp.id)
    results.attemptWithoutTimestamp = await expectSqlState(pool, 'attempt without timestamp', '23514', (client) => insertEvent(client, attemptWithoutTimestamp, { attempts: 1 }))

    const raceRuns = []
    for (let repetition = 0; repetition < RACE_REPETITIONS; repetition += 1) {
      const race = fixture(`claim-race-${repetition}`)
      cleanupIds.add(race.id)
      await withTransaction(pool, (client) => insertEvent(client, race))
      const startedAt = Date.now()
      const claims = await Promise.all(Array.from({ length: RACE_ATTEMPTS }, () => claimOne(pool)))
      const winners = claims.filter(Boolean)
      assert.equal(winners.length, 1, 'exactly one concurrent claimant must win')
      assert.equal(claims.filter((claim) => claim === null).length, RACE_ATTEMPTS - 1, 'all losing claimants must observe SKIP LOCKED')
      assert.equal(winners[0].attempts, 1, 'the winning claim must increment attempts exactly once')
      assert.match(winners[0].lease_token, /^[0-9a-f-]{36}$/i)
      const staleCompletion = await pool.query(`
        UPDATE outbox_events
           SET processed_at = CURRENT_TIMESTAMP,
               lease_token = NULL,
               lease_acquired_at = NULL,
               lease_expires_at = NULL
         WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL
         RETURNING id
      `, [race.id, randomUUID()])
      assert.equal(staleCompletion.rows.length, 0, 'stale lease token must not complete another worker event')
      const completion = await pool.query(`
        UPDATE outbox_events
           SET processed_at = CURRENT_TIMESTAMP,
               lease_token = NULL,
               lease_acquired_at = NULL,
               lease_expires_at = NULL
         WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL
         RETURNING id
      `, [race.id, winners[0].lease_token])
      assert.equal(completion.rows.length, 1, 'current lease token must complete the claimed event')
      const persisted = (await pool.query(`
        SELECT processed_at, lease_token, lease_acquired_at, lease_expires_at, attempts, last_attempt_at, dead_lettered_at
          FROM outbox_events WHERE id = $1
      `, [race.id])).rows[0]
      assert.ok(persisted.processed_at)
      assert.equal(persisted.lease_token, null)
      assert.equal(persisted.lease_acquired_at, null)
      assert.equal(persisted.lease_expires_at, null)
      assert.equal(persisted.attempts, 1)
      assert.ok(persisted.last_attempt_at)
      assert.equal(persisted.dead_lettered_at, null)
      raceRuns.push({
        status: 'passed',
        attempts: RACE_ATTEMPTS,
        winners: winners.length,
        losers: RACE_ATTEMPTS - winners.length,
        staleCompletionRejected: true,
        currentTokenCompletionAccepted: true,
        persistedProcessed: true,
        elapsedMs: Date.now() - startedAt
      })
    }
    results.concurrentClaim = {
      status: 'verified',
      attempts: RACE_ATTEMPTS,
      repetitions: RACE_REPETITIONS,
      totalAttempts: RACE_ATTEMPTS * RACE_REPETITIONS,
      validRuns: raceRuns.length,
      performance: summarizeDurations(raceRuns.map((run) => run.elapsedMs)),
      runs: raceRuns
    }
    return { status: 'verified', cases: results, cleanupIds: cleanupIds.size }
  } finally {
    const ids = [...cleanupIds]
    await withTransaction(pool, (client) => client.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [ids]))
  }
}

async function main() {
  assertBounds()
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_020_CONTRACT_ISOLATED=true is required', migration: '020_outbox_lease_state', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({
      ...report,
      migration: '020_outbox_lease_state',
      databaseIsolation: true,
      cleanupPerformed: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }))
  } catch (error) {
    console.error(json({
      status: 'blocked',
      reason: error.message,
      code: error.code || null,
      migration: '020_outbox_lease_state',
      databaseIsolation: true,
      cleanupPerformed: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
