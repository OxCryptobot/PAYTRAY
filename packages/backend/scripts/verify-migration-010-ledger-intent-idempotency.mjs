import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '010_ledger_intent_idempotency'
const DATABASE_URL = process.env.MIGRATION_010_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_010_CONTRACT_ISOLATED === 'true'

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
  if (!value) throw new Error('MIGRATION_010_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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
  const index = await client.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'ledger_entries'
       AND indexname = 'ledger_entries_intent_type_unique'
  `)
  assert.equal(index.rows.length, 1)
  assert.match(index.rows[0].indexdef, /UNIQUE INDEX/i)
  assert.match(index.rows[0].indexdef, /source_intent_id/i)
  assert.match(index.rows[0].indexdef, /entry_type/i)
  assert.match(index.rows[0].indexdef, /WHERE \(source_intent_id IS NOT NULL\)/i)

  const provenanceCheck = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.ledger_entries'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%source_chain_event_id%source_intent_id%'
  `)
  assert.equal(provenanceCheck.rows.length, 1)
  assert.match(provenanceCheck.rows[0].definition, /source_chain_event_id IS NOT NULL.*source_intent_id IS NOT NULL/is)
  return { status: 'passed', index: index.rows[0].indexname, partialPredicate: 'source_intent_id IS NOT NULL', provenanceConstraint: provenanceCheck.rows[0].conname }
}

async function createLedgerFixture(client, suffix) {
  const users = await client.query(`
    INSERT INTO users (wallet_address) VALUES ($1), ($2) RETURNING id
  `, [`migration010-client-${suffix}`, `migration010-provider-${suffix}`])
  const accounts = await client.query(`
    INSERT INTO ledger_accounts (owner_user_id, chain_id, token_address, account_type)
    VALUES ($1, 84532, $3, 'client_escrow'), ($2, 84532, $3, 'provider_available')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id, '0x0000000000000000000000000000000000000001'])
  const intent = await client.query(`
    INSERT INTO payment_intents (
      sender_id, recipient_id, intent_type, chain_id, token_address, token_decimals,
      amount_base_units, idempotency_key, request_hash, status
    ) VALUES ($1, $2, 'create_stream', 84532, $3, 6, 1000000, $4, $5, 'intent_created')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id, '0x0000000000000000000000000000000000000001', `migration010-intent-${suffix}`, 'c'.repeat(64)])
  return { userIds: users.rows.map((row) => row.id), accountIds: accounts.rows.map((row) => row.id), intentId: intent.rows[0].id }
}

async function insertLedgerEntry(client, fixture, entryType = 'stream_funding') {
  return client.query(`
    INSERT INTO ledger_entries (
      source_intent_id, debit_account_id, credit_account_id, entry_type,
      amount_base_units, chain_id, token_address
    ) VALUES ($1, $2, $3, $4, 1000000, 84532, $5)
    RETURNING id, source_intent_id, entry_type
  `, [fixture.intentId, fixture.accountIds[0], fixture.accountIds[1], entryType, '0x0000000000000000000000000000000000000001'])
}

async function intentEntryRace(pool, fixture, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertLedgerEntry(client, fixture))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one duplicate intent-entry writer must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining duplicate intent-entry writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'every duplicate intent-entry loser must return SQLSTATE 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const userIds = []
  const accountIds = []
  const intentIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createLedgerFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    userIds.push(...fixture.userIds)
    accountIds.push(...fixture.accountIds)
    intentIds.push(fixture.intentId)

    const first = await withTransaction(pool, (client) => insertLedgerEntry(client, fixture))
    const duplicate = await expectSqlState(pool, 'duplicate intent and entry type', '23505', (client) => insertLedgerEntry(client, fixture))
    const differentType = await withTransaction(pool, (client) => insertLedgerEntry(client, fixture, 'stream_release'))
    assert.equal(first.rows[0].source_intent_id, fixture.intentId)
    assert.equal(differentType.rows[0].entry_type, 'stream_release')

    const nullProvenance = await expectSqlState(pool, 'ledger entry without source provenance', '23514', (client) => client.query(`
      INSERT INTO ledger_entries (
        debit_account_id, credit_account_id, entry_type, amount_base_units, chain_id, token_address
      ) VALUES ($1, $2, 'unprovenanced', 1, 84532, $3)
    `, [fixture.accountIds[0], fixture.accountIds[1], '0x0000000000000000000000000000000000000001']))

    const raceRuns = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const raceFixture = await withTransaction(pool, (client) => createLedgerFixture(client, `race-${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`))
      userIds.push(...raceFixture.userIds)
      accountIds.push(...raceFixture.accountIds)
      intentIds.push(raceFixture.intentId)
      raceRuns.push(await intentEntryRace(pool, raceFixture, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        duplicateIntentEntry: duplicate,
        distinctEntryType: { status: 'passed', entryType: differentType.rows[0].entry_type },
        missingProvenance: nullProvenance,
        concurrentDuplicateIntentEntry: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: raceRuns.length, runs: raceRuns }
      },
      cleanupRows: { ledgerEntries: 'all fixture entries', intents: intentIds.length, accounts: accountIds.length, users: userIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM ledger_entries WHERE source_intent_id = ANY($1::uuid[])', [intentIds])
      await client.query('DELETE FROM payment_intents WHERE id = ANY($1::uuid[])', [intentIds])
      await client.query('DELETE FROM ledger_accounts WHERE id = ANY($1::uuid[])', [accountIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_010_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_010_CONCURRENCY_ATTEMPTS', 8, 2, 16)
  const repetitions = boundedInteger('MIGRATION_010_CONCURRENCY_REPETITIONS', 3, 1, 10)
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
