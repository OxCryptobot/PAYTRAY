#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = path.resolve(__dirname, '../migrations')
const MIGRATION = '005_outcomes_and_metrics'
const DATABASE_URL = process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_005_CONTRACT_ISOLATED === 'true'
const CHAINLESS = 'migration-005-verifier'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function boundedInteger(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`)
  }
  return value
}

function assertDisposableDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }
  const hostAllowed = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  const databaseName = parsed.pathname.replace(/^\//, '')
  const databaseAllowed = /(ci|test|disposable|recovery)/i.test(databaseName)
  if (!hostAllowed || !databaseAllowed) {
    throw new Error('migration-005 verifier refuses a non-disposable database URL')
  }
}

async function withTransaction(pool, callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original contract failure.
    }
    throw error
  } finally {
    client.release()
  }
}

async function runMigrations(client) {
  const ready = await client.query(`
    SELECT to_regclass('public.engagement_outcome_events') IS NOT NULL AS ready
  `)
  if (ready.rows[0]?.ready) return
  const files = (await readdir(MIGRATION_DIR))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
  for (const file of files) {
    await client.query(await readFile(path.join(MIGRATION_DIR, file), 'utf8'))
  }
}

async function expectSqlState(pool, label, expected, operation) {
  try {
    await withTransaction(pool, operation)
    throw new Error(`${label}: expected PostgreSQL SQLSTATE ${expected}`)
  } catch (error) {
    if (error.message === `${label}: expected PostgreSQL SQLSTATE ${expected}`) throw error
    assert.equal(error.code, expected, `${label}: unexpected SQLSTATE or assertion failure`)
    return { status: 'passed', sqlState: error.code }
  }
}

async function verifyCatalog(client) {
  const columns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'engagement_outcome_events'
       AND column_name IN ('id', 'engagement_id', 'event_type', 'actor_type', 'actor_id', 'evidence_type', 'evidence_id', 'payload', 'verification_status', 'provenance', 'occurred_at', 'created_at')
     ORDER BY ordinal_position
  `)
  const expectedColumns = [
    'id', 'engagement_id', 'event_type', 'actor_type', 'actor_id', 'evidence_type',
    'evidence_id', 'payload', 'verification_status', 'provenance', 'occurred_at', 'created_at'
  ]
  assert.deepEqual(columns.rows.map((row) => row.column_name), expectedColumns)
  const required = new Map(columns.rows.map((row) => [row.column_name, row]))
  assert.equal(required.get('engagement_id').is_nullable, 'NO')
  assert.equal(required.get('event_type').is_nullable, 'NO')
  assert.equal(required.get('actor_type').is_nullable, 'NO')
  assert.equal(required.get('evidence_type').is_nullable, 'NO')
  assert.equal(required.get('payload').is_nullable, 'NO')
  assert.equal(required.get('verification_status').is_nullable, 'NO')
  assert.equal(required.get('provenance').is_nullable, 'NO')
  assert.match(required.get('payload').column_default, /\{\}/)
  assert.match(required.get('provenance').column_default, /\{\}/)
  assert.match(required.get('verification_status').column_default, /unverified/)

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'engagement_outcome_events'
     ORDER BY indexname
  `)
  const indexNames = indexes.rows.map((row) => row.indexname)
  assert.ok(indexNames.includes('engagement_outcome_events_metric_index'))
  assert.ok(indexNames.includes('engagement_outcome_events_engagement_index'))

  const constraints = await client.query(`
    SELECT contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.engagement_outcome_events'::regclass
     ORDER BY contype, definition
  `)
  const definitions = constraints.rows.map((row) => row.definition)
  assert.ok(definitions.some((value) => value.includes('engagement_id')))
  assert.ok(definitions.some((value) => value.includes('meeting_completed')))
  assert.ok(definitions.some((value) => value.includes('client') && value.includes('provider')))
  assert.ok(definitions.some((value) => value.includes('unverified') && value.includes('verified') && value.includes('rejected')))
  assert.ok(definitions.some((value) => value.includes('session') && value.includes('payment_chain_event')))
  assert.ok(definitions.some((value) => value.includes('UNIQUE') && value.includes('event_type')))

  return {
    status: 'passed',
    columns: expectedColumns.length,
    indexes: ['engagement_outcome_events_metric_index', 'engagement_outcome_events_engagement_index'],
    checkConstraintCount: constraints.rows.filter((row) => row.contype === 'c').length,
    foreignKeyCount: constraints.rows.filter((row) => row.contype === 'f').length,
    uniqueBoundary: definitions.find((value) => value.includes('UNIQUE') && value.includes('event_type')) || null
  }
}

async function createFixture(client, suffix) {
  const users = await client.query(`
    INSERT INTO users (wallet_address, wallet_type)
    VALUES ($1, 'injected'), ($2, 'injected')
    RETURNING id
  `, [`${CHAINLESS}-${suffix}-client`, `${CHAINLESS}-${suffix}-provider`])
  const engagement = await client.query(`
    INSERT INTO engagements (client_id, provider_id, status)
    VALUES ($1, $2, 'active')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id])
  return { userIds: users.rows.map((row) => row.id), engagementId: engagement.rows[0].id }
}

async function insertOutcome(client, fixture, suffix, overrides = {}) {
  const values = {
    engagementId: fixture.engagementId,
    eventType: 'meeting_completed',
    actorType: 'client',
    actorId: fixture.userIds[0],
    evidenceType: 'engagement',
    evidenceId: `${CHAINLESS}-${suffix}`,
    payload: '{}',
    verificationStatus: 'unverified',
    provenance: '{}',
    occurredAt: '2026-08-21T12:00:00.000Z'
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO engagement_outcome_events (
      engagement_id, event_type, actor_type, actor_id, evidence_type, evidence_id,
      payload, verification_status, provenance, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
    RETURNING id, event_type, actor_type, evidence_type, evidence_id, payload, verification_status, provenance
  `, [values.engagementId, values.eventType, values.actorType, values.actorId, values.evidenceType, values.evidenceId, values.payload, values.verificationStatus, values.provenance, values.occurredAt])
}

async function duplicateOutcomeRace(pool, fixture, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertOutcome(client, fixture, `race-${key}`, {
        eventType: 'repeat_booking',
        actorType: 'system',
        evidenceType: 'engagement'
      }))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one duplicate outcome writer must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining duplicate outcome writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'every duplicate outcome loser must return SQLSTATE 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function verifierTransitionRace(pool, fixture, key, attempts) {
  const seeded = await withTransaction(pool, (client) => insertOutcome(client, fixture, `transition-${key}`, { evidenceType: 'session' }))
  const outcomeId = seeded.rows[0].id
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    return withTransaction(pool, async (client) => {
      const locked = await client.query('SELECT id FROM engagement_outcome_events WHERE id = $1 FOR UPDATE', [outcomeId])
      assert.equal(locked.rowCount, 1)
      const updated = await client.query(`
        UPDATE engagement_outcome_events
           SET verification_status = 'verified', actor_type = 'verifier', actor_id = $2,
               provenance = jsonb_build_object('source', $3::text)
         WHERE id = $1 AND verification_status = 'unverified'
         RETURNING id, verification_status
      `, [outcomeId, CHAINLESS, CHAINLESS])
      return { status: updated.rowCount === 1 ? 'winner' : 'no_op' }
    }).catch((error) => ({ status: 'error', sqlState: error.code || null }))
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'winner')
  const noOps = outcomes.filter((outcome) => outcome.status === 'no_op')
  assert.equal(winners.length, 1, `exactly one verifier-owned transition must win: ${json(outcomes)}`)
  assert.equal(noOps.length, attempts - 1, `all later verifier-owned transitions must become no-ops: ${json(outcomes)}`)
  assert.ok(outcomes.every((outcome) => outcome.status === 'winner' || outcome.status === 'no_op'), `transition race must not produce database errors: ${json(outcomes)}`)
  const persisted = await pool.query('SELECT verification_status, actor_type, actor_id FROM engagement_outcome_events WHERE id = $1', [outcomeId])
  assert.deepEqual(persisted.rows[0], { verification_status: 'verified', actor_type: 'verifier', actor_id: CHAINLESS })
  return { status: 'passed', attempts, winners: winners.length, noOps: noOps.length, persistedStatus: 'verified' }
}

async function runContractSuite(pool, attempts, repetitions) {
  const userIds = []
  const engagementIds = []
  const outcomeIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    userIds.push(...fixture.userIds)
    engagementIds.push(fixture.engagementId)

    const valid = await withTransaction(pool, (client) => insertOutcome(client, fixture, 'base'))
    outcomeIds.push(valid.rows[0].id)
    assert.deepEqual(valid.rows[0].payload, {})
    assert.deepEqual(valid.rows[0].provenance, {})
    assert.equal(valid.rows[0].verification_status, 'unverified')

    const duplicateIdentity = await expectSqlState(pool, 'duplicate outcome identity', '23505', (client) => insertOutcome(client, fixture, 'base'))
    const invalidEventType = await expectSqlState(pool, 'invalid outcome event type', '23514', (client) => insertOutcome(client, fixture, 'invalid-event', { eventType: 'unknown' }))
    const invalidActorType = await expectSqlState(pool, 'invalid outcome actor type', '23514', (client) => insertOutcome(client, fixture, 'invalid-actor', { actorType: 'unknown' }))
    const invalidReviewState = await expectSqlState(pool, 'invalid outcome verification status', '23514', (client) => insertOutcome(client, fixture, 'invalid-status', { verificationStatus: 'pending' }))
    const invalidEvidenceType = await expectSqlState(pool, 'invalid outcome evidence type', '23514', (client) => insertOutcome(client, fixture, 'invalid-evidence', { evidenceType: 'unknown' }))
    const missingEngagement = await expectSqlState(pool, 'missing outcome engagement', '23503', (client) => insertOutcome(client, fixture, 'missing-engagement', { engagementId: '00000000-0000-0000-0000-000000000000' }))
    const nullOccurredAt = await expectSqlState(pool, 'null outcome occurred_at', '23502', (client) => insertOutcome(client, fixture, 'null-occurred', { occurredAt: null }))
    const nullEventType = await expectSqlState(pool, 'null outcome event type', '23502', (client) => insertOutcome(client, fixture, 'null-event', { eventType: null }))
    const nullActorType = await expectSqlState(pool, 'null outcome actor type', '23502', (client) => insertOutcome(client, fixture, 'null-actor', { actorType: null }))

    const duplicateRaces = []
    const transitionRaces = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const key = `${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`
      duplicateRaces.push(await duplicateOutcomeRace(pool, fixture, key, attempts))
      transitionRaces.push(await verifierTransitionRace(pool, fixture, key, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        validRoundTrip: { status: 'passed', defaults: true, verificationStatus: 'unverified' },
        duplicateIdentity,
        invalidEventType,
        invalidActorType,
        invalidReviewState,
        invalidEvidenceType,
        missingEngagement,
        nullOccurredAt,
        nullEventType,
        nullActorType,
        concurrentDuplicateIdentity: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: duplicateRaces },
        concurrentVerifierTransition: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: transitionRaces }
      },
      cleanupRows: { users: userIds.length, engagements: engagementIds.length, outcomeEvents: 'all events for verifier engagements' }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM engagement_outcome_events WHERE engagement_id = ANY($1::uuid[])', [engagementIds])
      await client.query('DELETE FROM engagements WHERE id = ANY($1::uuid[])', [engagementIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_005_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_005_CONCURRENCY_ATTEMPTS', 4, 2, 16)
  const repetitions = boundedInteger('MIGRATION_005_CONCURRENCY_REPETITIONS', 2, 1, 10)
  const pool = new Pool({ connectionString: DATABASE_URL, max: attempts + 4, min: 0, connectionTimeoutMillis: 5000 })
  let cleanupPerformed = false
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool, attempts, repetitions)
    cleanupPerformed = true
    console.log(json({ ...report, migration: MIGRATION, databaseIsolation: true, cleanupPerformed, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: MIGRATION, databaseIsolation: true, cleanupPerformed, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
