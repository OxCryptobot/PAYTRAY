#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = path.resolve(__dirname, '../migrations')
const MIGRATION = '004_engagement_context'
const DATABASE_URL = process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_004_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function boundedInteger(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL') }
  const hostAllowed = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  const databaseAllowed = /(ci|test|disposable|recovery)/i.test(parsed.pathname.replace(/^\//, ''))
  if (!hostAllowed || !databaseAllowed) throw new Error('migration-004 verifier refuses a non-disposable database URL')
}

async function withTransaction(pool, callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally {
    client.release()
  }
}

async function runMigrations(client) {
  const ready = await client.query(`
    SELECT (
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'engagements' AND column_name IN ('discovery_context', 'ranking_explanation', 'proposed_terms', 'collaboration_status', 'payment_status', 'context_version')) = 6
      AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.engagements'::regclass AND conname IN ('engagements_collaboration_status_check', 'engagements_payment_status_check')) = 2
    ) AS ready
  `)
  if (ready.rows[0]?.ready) return
  const files = (await readdir(MIGRATION_DIR)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()
  for (const file of files) await client.query(await readFile(path.join(MIGRATION_DIR, file), 'utf8'))
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
     WHERE table_schema = 'public' AND table_name = 'engagements'
       AND column_name IN ('discovery_context', 'ranking_explanation', 'proposed_terms', 'collaboration_status', 'payment_status', 'context_version')
     ORDER BY column_name
  `)
  assert.deepEqual(columns.rows.map((row) => row.column_name), ['collaboration_status', 'context_version', 'discovery_context', 'payment_status', 'proposed_terms', 'ranking_explanation'])
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
  for (const name of ['discovery_context', 'ranking_explanation', 'proposed_terms', 'collaboration_status', 'payment_status', 'context_version']) assert.equal(byName.get(name).is_nullable, 'NO')
  assert.match(byName.get('discovery_context').column_default, /\{\}/)
  assert.match(byName.get('ranking_explanation').column_default, /\{\}/)
  assert.match(byName.get('proposed_terms').column_default, /\{\}/)
  assert.match(byName.get('collaboration_status').column_default, /not_started/)
  assert.match(byName.get('payment_status').column_default, /not_requested/)
  assert.match(byName.get('context_version').column_default, /1/)

  const indexes = await client.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'engagements'
       AND indexname IN ('engagements_participant_status_index', 'engagements_thread_index')
     ORDER BY indexname
  `)
  assert.deepEqual(indexes.rows.map((row) => row.indexname), ['engagements_participant_status_index', 'engagements_thread_index'])

  const constraints = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.engagements'::regclass
       AND conname IN ('engagements_collaboration_status_check', 'engagements_payment_status_check')
     ORDER BY conname
  `)
  assert.equal(constraints.rows.length, 2)
  assert.ok(constraints.rows.some((row) => row.definition.includes('not_started') && row.definition.includes('degraded') && row.definition.includes('completed')))
  assert.ok(constraints.rows.some((row) => row.definition.includes('not_requested') && row.definition.includes('chain_finalized') && row.definition.includes('ledger_reflected')))

  return { status: 'passed', columns: 6, indexes: indexes.rows.map((row) => row.indexname), checkConstraints: constraints.rows.map((row) => row.conname) }
}

async function createFixture(client, suffix) {
  const users = await client.query(`
    INSERT INTO users (wallet_address, wallet_type)
    VALUES ($1, 'injected'), ($2, 'injected')
    RETURNING id
  `, [`migration-004-${suffix}-client`, `migration-004-${suffix}-provider`])
  const engagement = await client.query(`
    INSERT INTO engagements (client_id, provider_id, status)
    VALUES ($1, $2, 'active')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id])
  return { userIds: users.rows.map((row) => row.id), engagementId: engagement.rows[0].id }
}

async function updateContext(client, fixture, overrides = {}) {
  const values = {
    discoveryContext: JSON.stringify({ source: 'migration-004-verifier' }),
    rankingExplanation: JSON.stringify({ rank: 1 }),
    proposedTerms: JSON.stringify({ hourlyRate: '1.00' }),
    collaborationStatus: 'ready',
    paymentStatus: 'not_requested',
    contextVersion: 2
  }
  Object.assign(values, overrides)
  return client.query(`
    UPDATE engagements
       SET discovery_context = $2::jsonb,
           ranking_explanation = $3::jsonb,
           proposed_terms = $4::jsonb,
           collaboration_status = $5,
           payment_status = $6,
           context_version = $7,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, discovery_context, ranking_explanation, proposed_terms, collaboration_status, payment_status, context_version
  `, [fixture.engagementId, values.discoveryContext, values.rankingExplanation, values.proposedTerms, values.collaborationStatus, values.paymentStatus, values.contextVersion])
}

async function stateUpdateRace(pool, fixture, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async (_, index) => {
    try {
      await withTransaction(pool, async (client) => {
        const result = await client.query(`
          UPDATE engagements
             SET collaboration_status = 'degraded', context_version = context_version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND collaboration_status = 'ready' AND context_version = $2
           RETURNING id
        `, [fixture.engagementId, 2])
        if (result.rowCount !== 1) throw Object.assign(new Error('optimistic engagement context update lost'), { code: 'PT004_LOST_UPDATE' })
      })
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null, reason: error.code === 'PT004_LOST_UPDATE' ? 'optimistic_update_conflict' : error.message, contender: index, key }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one optimistic context update must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining optimistic context updates must reject')
  assert.ok(losers.every((outcome) => outcome.reason === 'optimistic_update_conflict'), 'all context race losers must be classified as safe no-op conflicts')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, loserClassification: 'optimistic_update_conflict' }
}

async function runContractSuite(pool, attempts, repetitions) {
  const userIds = []
  const engagementIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    userIds.push(...fixture.userIds)
    engagementIds.push(fixture.engagementId)

    const defaults = await pool.query(`
      SELECT discovery_context, ranking_explanation, proposed_terms, collaboration_status, payment_status, context_version
        FROM engagements WHERE id = $1
    `, [fixture.engagementId])
    assert.deepEqual(defaults.rows[0], { discovery_context: {}, ranking_explanation: {}, proposed_terms: {}, collaboration_status: 'not_started', payment_status: 'not_requested', context_version: 1 })
    const roundTrip = await withTransaction(pool, (client) => updateContext(client, fixture))
    assert.deepEqual(roundTrip.rows[0].discovery_context, { source: 'migration-004-verifier' })
    assert.equal(roundTrip.rows[0].collaboration_status, 'ready')
    assert.equal(roundTrip.rows[0].payment_status, 'not_requested')
    assert.equal(roundTrip.rows[0].context_version, 2)

    const invalidCollaboration = await expectSqlState(pool, 'invalid collaboration status', '23514', (client) => updateContext(client, fixture, { collaborationStatus: 'unknown' }))
    const invalidPayment = await expectSqlState(pool, 'invalid payment status', '23514', (client) => updateContext(client, fixture, { paymentStatus: 'unknown' }))
    const nullCollaboration = await expectSqlState(pool, 'null collaboration status', '23502', (client) => updateContext(client, fixture, { collaborationStatus: null }))
    const nullPayment = await expectSqlState(pool, 'null payment status', '23502', (client) => updateContext(client, fixture, { paymentStatus: null }))
    const nullDiscoveryContext = await expectSqlState(pool, 'null discovery context', '23502', (client) => updateContext(client, fixture, { discoveryContext: null }))
    const nullRankingExplanation = await expectSqlState(pool, 'null ranking explanation', '23502', (client) => updateContext(client, fixture, { rankingExplanation: null }))
    const invalidContextVersion = await expectSqlState(pool, 'null context version', '23502', (client) => updateContext(client, fixture, { contextVersion: null }))

    const races = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      await withTransaction(pool, (client) => client.query("UPDATE engagements SET collaboration_status = 'ready', context_version = 2 WHERE id = $1", [fixture.engagementId]))
      races.push(await stateUpdateRace(pool, fixture, `${Date.now()}-${repetition}`, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        defaults: { status: 'passed', collaborationStatus: 'not_started', paymentStatus: 'not_requested', contextVersion: 1 },
        roundTrip: { status: 'passed', collaborationStatus: 'ready', paymentStatus: 'not_requested', contextVersion: 2 },
        invalidCollaboration,
        invalidPayment,
        nullCollaboration,
        nullPayment,
        nullDiscoveryContext,
        nullRankingExplanation,
        invalidContextVersion,
        concurrentOptimisticContextUpdate: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: races }
      },
      cleanupRows: { users: userIds.length, engagements: engagementIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM engagements WHERE id = ANY($1::uuid[])', [engagementIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_004_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_004_CONCURRENCY_ATTEMPTS', 4, 2, 16)
  const repetitions = boundedInteger('MIGRATION_004_CONCURRENCY_REPETITIONS', 2, 1, 10)
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
