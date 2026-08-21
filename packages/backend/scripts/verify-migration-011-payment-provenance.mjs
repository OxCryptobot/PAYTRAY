import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_011_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_011_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_011_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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

async function insertUser(client, walletAddress) {
  const result = await client.query(`
    INSERT INTO users (wallet_address, wallet_type)
    VALUES ($1, 'injected')
    RETURNING id
  `, [walletAddress])
  return result.rows[0].id
}

async function insertStream(client, senderId, recipientId) {
  const result = await client.query(`
    INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds)
    VALUES ($1, $2, 'USDC', 1.25, 60)
    RETURNING id, last_verified_event
  `, [senderId, recipientId])
  return result.rows[0]
}

async function runContractSuite(pool) {
  const fixture = { userIds: [], streamId: null }
  const results = {}
  try {
    results.catalog = await withTransaction(pool, async (client) => {
      const column = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'payment_streams'
           AND column_name = 'last_verified_event'
      `)
      assert.equal(column.rows.length, 1)
      assert.deepEqual(column.rows[0], {
        column_name: 'last_verified_event',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: "'{}'::jsonb"
      })
      return { status: 'passed', column: column.rows[0] }
    })

    results.nullProvenance = await expectSqlState(pool, 'null last_verified_event', '23502', async (client) => {
      const senderId = await insertUser(client, `migration011-null-sender-${randomUUID()}`)
      const recipientId = await insertUser(client, `migration011-null-recipient-${randomUUID()}`)
      await client.query(`
        INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds, last_verified_event)
        VALUES ($1, $2, 'USDC', 1.25, 60, NULL)
      `, [senderId, recipientId])
    })

    const senderId = await withTransaction(pool, (client) => insertUser(client, `migration011-sender-${randomUUID()}`))
    const recipientId = await withTransaction(pool, (client) => insertUser(client, `migration011-recipient-${randomUUID()}`))
    fixture.userIds.push(senderId, recipientId)
    const stream = await withTransaction(pool, (client) => insertStream(client, senderId, recipientId))
    fixture.streamId = stream.id
    assert.deepEqual(stream.last_verified_event, {})

    const provenance = {
      source: 'local_disposable_contract',
      eventId: randomUUID(),
      observedAt: '2026-08-21T00:00:00.000Z'
    }
    const updated = await pool.query(`
      UPDATE payment_streams
         SET last_verified_event = $1::jsonb
       WHERE id = $2
       RETURNING last_verified_event
    `, [JSON.stringify(provenance), fixture.streamId])
    assert.deepEqual(updated.rows[0].last_verified_event, provenance)
    const roundTrip = await pool.query('SELECT last_verified_event FROM payment_streams WHERE id = $1', [fixture.streamId])
    assert.deepEqual(roundTrip.rows[0].last_verified_event, provenance)
    results.roundTrip = {
      status: 'passed',
      defaultValue: {},
      persistedKeys: Object.keys(provenance).sort(),
      roundTripMatches: true
    }

    return {
      status: 'verified',
      cases: results,
      cleanupUsers: fixture.userIds.length,
      cleanupStreams: fixture.streamId ? 1 : 0
    }
  } finally {
    await withTransaction(pool, async (client) => {
      if (fixture.streamId) await client.query('DELETE FROM payment_streams WHERE id = $1', [fixture.streamId])
      if (fixture.userIds.length > 0) await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [fixture.userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_011_CONTRACT_ISOLATED=true is required', migration: '011_payment_stream_verifier_provenance', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({
      ...report,
      migration: '011_payment_stream_verifier_provenance',
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
      migration: '011_payment_stream_verifier_provenance',
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
