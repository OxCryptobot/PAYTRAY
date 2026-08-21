import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '009_verified_outcome_provenance'
const DATABASE_URL = process.env.MIGRATION_009_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_009_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_009_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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
    SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'engagement_outcome_events'
       AND column_name IN ('verification_actor_id', 'verified_at', 'verification_evidence_hash')
     ORDER BY column_name
  `)
  assert.deepEqual(columns.rows, [
    { column_name: 'verification_actor_id', data_type: 'character varying', character_maximum_length: 255 },
    { column_name: 'verification_evidence_hash', data_type: 'character varying', character_maximum_length: 64 },
    { column_name: 'verified_at', data_type: 'timestamp without time zone', character_maximum_length: null }
  ])

  const index = await client.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'engagement_outcome_events'
       AND indexname = 'engagement_outcome_events_verified_index'
  `)
  assert.equal(index.rows.length, 1)
  assert.match(index.rows[0].indexdef, /verification_status/i)
  assert.match(index.rows[0].indexdef, /verified_at/i)
  return { status: 'passed', addedColumns: columns.rows.map((row) => row.column_name), index: index.rows[0].indexname }
}

async function createOutcomeFixture(client, suffix) {
  const users = await client.query(`
    INSERT INTO users (wallet_address) VALUES ($1), ($2) RETURNING id
  `, [`migration009-client-${suffix}`, `migration009-provider-${suffix}`])
  const engagement = await client.query(`
    INSERT INTO engagements (client_id, provider_id, status)
    VALUES ($1, $2, 'active')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id])
  const outcome = await client.query(`
    INSERT INTO engagement_outcome_events (
      engagement_id, event_type, actor_type, actor_id, evidence_type, evidence_id, occurred_at
    ) VALUES ($1, 'meeting_completed', 'verifier', $2, 'engagement', $3, $4)
    RETURNING id, verification_status, verification_actor_id, verified_at, verification_evidence_hash
  `, [engagement.rows[0].id, 'verifier-009', `evidence-${suffix}`, '2026-08-20T00:00:00.000Z'])
  return { userIds: users.rows.map((row) => row.id), engagementId: engagement.rows[0].id, outcomeId: outcome.rows[0].id, initial: outcome.rows[0] }
}

async function runContractSuite(pool) {
  const userIds = []
  const engagementIds = []
  const outcomeIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createOutcomeFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    userIds.push(...fixture.userIds)
    engagementIds.push(fixture.engagementId)
    outcomeIds.push(fixture.outcomeId)
    assert.equal(fixture.initial.verification_status, 'unverified')
    assert.equal(fixture.initial.verification_actor_id, null)
    assert.equal(fixture.initial.verified_at, null)
    assert.equal(fixture.initial.verification_evidence_hash, null)

    const verifiedAt = '2026-08-20T01:02:03.000Z'
    const evidenceHash = 'a'.repeat(64)
    const verified = await withTransaction(pool, (client) => client.query(`
      UPDATE engagement_outcome_events
         SET verification_status = 'verified', verification_actor_id = $2, verified_at = $3, verification_evidence_hash = $4
       WHERE id = $1
      RETURNING verification_status, verification_actor_id, verified_at, verification_evidence_hash
    `, [fixture.outcomeId, 'verifier-009-roundtrip', verifiedAt, evidenceHash]))
    assert.deepEqual(verified.rows[0], {
      verification_status: 'verified',
      verification_actor_id: 'verifier-009-roundtrip',
      verified_at: new Date(verifiedAt),
      verification_evidence_hash: evidenceHash
    })

    const invalidStatus = await expectSqlState(pool, 'invalid verification status', '23514', (client) => client.query(`
      INSERT INTO engagement_outcome_events (
        engagement_id, event_type, actor_type, evidence_type, evidence_id, occurred_at, verification_status
      ) VALUES ($1, 'repeat_booking', 'system', 'engagement', $2, $3, 'pending')
    `, [fixture.engagementId, `invalid-status-${Date.now()}`, '2026-08-20T00:00:00.000Z']))

    const oversizedHash = await expectSqlState(pool, 'oversized verification evidence hash', '22001', (client) => client.query(`
      UPDATE engagement_outcome_events
         SET verification_evidence_hash = $2
       WHERE id = $1
    `, [fixture.outcomeId, 'b'.repeat(65)]))

    const persisted = await withTransaction(pool, (client) => client.query(`
      SELECT verification_status, verification_actor_id, verified_at, verification_evidence_hash
        FROM engagement_outcome_events
       WHERE id = $1
    `, [fixture.outcomeId]))
    assert.deepEqual(persisted.rows[0], verified.rows[0])

    return {
      status: 'verified',
      cases: { catalog, defaultValues: { status: 'passed' }, roundTrip: { status: 'passed', persisted: true }, invalidStatus, oversizedHash },
      cleanupRows: { outcomes: outcomeIds.length, engagements: engagementIds.length, users: userIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM engagement_outcome_events WHERE id = ANY($1::uuid[])', [outcomeIds])
      await client.query('DELETE FROM engagements WHERE id = ANY($1::uuid[])', [engagementIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_009_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({ ...report, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
