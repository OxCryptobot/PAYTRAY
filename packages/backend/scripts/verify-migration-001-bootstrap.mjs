#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = path.resolve(__dirname, '../migrations')
const MIGRATION = '001_init'
const DATABASE_URL = process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_001_CONTRACT_ISOLATED === 'true'

function json(value) { return JSON.stringify(value, null, 2) }

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
  if (!hostAllowed || !databaseAllowed) throw new Error('migration-001 verifier refuses a non-disposable database URL')
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
  } finally { client.release() }
}

async function runMigrations(client) {
  const ready = await client.query(`
    SELECT (
      (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relname IN ('users', 'profiles', 'payment_streams', 'video_calls', 'wallet_connections', 'schema_migrations')) = 6
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
  const expectedTables = ['users', 'profiles', 'payment_streams', 'video_calls', 'wallet_connections', 'schema_migrations']
  const tables = await client.query(`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename
  `, [expectedTables])
  assert.deepEqual(tables.rows.map((row) => row.tablename), expectedTables.slice().sort())

  const requiredColumns = {
    users: ['id', 'wallet_address', 'wallet_type', 'ens_name', 'is_active', 'last_login', 'created_at', 'updated_at'],
    profiles: ['id', 'user_id', 'name', 'bio', 'hourly_rate', 'expertise', 'social_links', 'is_expert', 'completeness', 'created_at', 'updated_at'],
    payment_streams: ['id', 'sender_id', 'recipient_id', 'token_symbol', 'amount', 'duration_seconds', 'start_time', 'stop_time', 'status', 'amount_withdrawn', 'created_at', 'updated_at'],
    video_calls: ['id', 'initiator_id', 'recipient_id', 'livekit_room_name', 'status', 'created_at'],
    wallet_connections: ['id', 'user_id', 'wallet_address', 'wallet_type', 'is_primary', 'verified', 'verified_at', 'created_at'],
    schema_migrations: ['id', 'migration_name', 'executed_at']
  }
  const columnCounts = {}
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])
      ORDER BY ordinal_position
    `, [table, columns])
    assert.deepEqual(result.rows.map((row) => row.column_name), columns)
    columnCounts[table] = columns.length
  }

  const constraints = await client.query(`
    SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND conrelid::regclass::text IN ('users', 'profiles', 'payment_streams', 'video_calls', 'wallet_connections', 'schema_migrations')
     ORDER BY table_name, contype, definition
  `)
  const definitions = constraints.rows.map((row) => row.definition)
  assert.ok(definitions.some((value) => value.includes('wallet_address')))
  assert.ok(definitions.some((value) => value.includes('migration_name')))
  assert.ok(definitions.filter((value) => value.startsWith('FOREIGN KEY')).length >= 5)
  return {
    status: 'passed',
    tables: expectedTables,
    columnCounts,
    primaryKeyCount: constraints.rows.filter((row) => row.contype === 'p').length,
    uniqueBoundaryCount: constraints.rows.filter((row) => row.contype === 'u').length,
    foreignKeyCount: constraints.rows.filter((row) => row.contype === 'f').length
  }
}

async function createFixture(client, prefix) {
  const user = await client.query(`INSERT INTO users (wallet_address, wallet_type) VALUES ($1, 'injected') RETURNING id`, [`${prefix}-user`])
  const otherUser = await client.query(`INSERT INTO users (wallet_address, wallet_type) VALUES ($1, 'injected') RETURNING id`, [`${prefix}-other`])
  const profile = await client.query(`INSERT INTO profiles (user_id, name) VALUES ($1, 'Migration 001 verifier') RETURNING id`, [user.rows[0].id])
  const stream = await client.query(`
    INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds)
    VALUES ($1, $2, 'USDC', 1.25, 60) RETURNING id
  `, [user.rows[0].id, otherUser.rows[0].id])
  const call = await client.query(`INSERT INTO video_calls (initiator_id, recipient_id) VALUES ($1, $2) RETURNING id`, [user.rows[0].id, otherUser.rows[0].id])
  const connection = await client.query(`INSERT INTO wallet_connections (user_id, wallet_address, wallet_type) VALUES ($1, $2, 'injected') RETURNING id`, [user.rows[0].id, `${prefix}-connected`])
  return { userId: user.rows[0].id, otherUserId: otherUser.rows[0].id, profileId: profile.rows[0].id, streamId: stream.rows[0].id, callId: call.rows[0].id, connectionId: connection.rows[0].id, prefix }
}

async function bootstrapIdempotencyRace(pool, prefix, attempts) {
  const migrationName = `${prefix}-migration`
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [migrationName]))
      return { status: 'committed' }
    } catch (error) { return { status: 'rejected', sqlState: error.code || null } }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one schema migration record must commit')
  assert.equal(losers.length, attempts - 1, 'duplicate schema migration writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'duplicate schema migration losers must return 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const prefixes = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const prefix = `migration-001-${Date.now()}-${Math.random().toString(16).slice(2)}`
    prefixes.push(prefix)
    const fixture = await withTransaction(pool, (client) => createFixture(client, prefix))

    const duplicateWallet = await expectSqlState(pool, 'duplicate wallet address', '23505', (client) => client.query('INSERT INTO users (wallet_address, wallet_type) VALUES ($1, \'injected\')', [`${prefix}-user`]))
    const duplicateMigrationName = await expectSqlState(pool, 'duplicate schema migration name', '23505', (client) => client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [`${prefix}-single`]).then(() => client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [`${prefix}-single`])))
    const missingProfileUser = await expectSqlState(pool, 'missing profile user', '23503', (client) => client.query("INSERT INTO profiles (user_id, name) VALUES ('00000000-0000-0000-0000-000000000000', 'invalid')"))
    const missingStreamSender = await expectSqlState(pool, 'missing stream sender', '23503', (client) => client.query(`
      INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds)
      VALUES ('00000000-0000-0000-0000-000000000000', $1, 'USDC', 1, 60)
    `, [fixture.otherUserId]))
    const missingStreamRecipient = await expectSqlState(pool, 'missing stream recipient', '23503', (client) => client.query(`
      INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds)
      VALUES ($1, '00000000-0000-0000-0000-000000000000', 'USDC', 1, 60)
    `, [fixture.userId]))
    const missingCallInitiator = await expectSqlState(pool, 'missing call initiator', '23503', (client) => client.query(`
      INSERT INTO video_calls (initiator_id, recipient_id) VALUES ('00000000-0000-0000-0000-000000000000', $1)
    `, [fixture.otherUserId]))
    const missingCallRecipient = await expectSqlState(pool, 'missing call recipient', '23503', (client) => client.query(`
      INSERT INTO video_calls (initiator_id, recipient_id) VALUES ($1, '00000000-0000-0000-0000-000000000000')
    `, [fixture.userId]))
    const missingConnectionUser = await expectSqlState(pool, 'missing wallet connection user', '23503', (client) => client.query(`
      INSERT INTO wallet_connections (user_id, wallet_address, wallet_type) VALUES ('00000000-0000-0000-0000-000000000000', $1, 'injected')
    `, [`${prefix}-invalid-connection`]))
    const nullWalletAddress = await expectSqlState(pool, 'null wallet address', '23502', (client) => client.query("INSERT INTO users (wallet_address) VALUES (NULL)"))
    const nullProfileUser = await expectSqlState(pool, 'null profile user', '23502', (client) => client.query("INSERT INTO profiles (user_id) VALUES (NULL)"))
    const nullStreamAssetSymbol = await expectSqlState(pool, 'null stream asset symbol', '23502', (client) => client.query(`
      INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds) VALUES ($1, $2, NULL, 1, 60)
    `, [fixture.userId, fixture.otherUserId]))
    const nullConnectionWallet = await expectSqlState(pool, 'null connection wallet address', '23502', (client) => client.query(`
      INSERT INTO wallet_connections (user_id, wallet_address, wallet_type) VALUES ($1, NULL, 'injected')
    `, [fixture.userId]))

    const races = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) races.push(await bootstrapIdempotencyRace(pool, `${prefix}-${repetition}`, attempts))

    const cascade = await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM users WHERE id = $1', [fixture.userId])
      const remaining = await client.query('SELECT count(*)::int AS count FROM profiles WHERE id = $1 UNION ALL SELECT count(*)::int FROM wallet_connections WHERE id = $2 UNION ALL SELECT count(*)::int FROM payment_streams WHERE id = $3 UNION ALL SELECT count(*)::int FROM video_calls WHERE id = $4', [fixture.profileId, fixture.connectionId, fixture.streamId, fixture.callId])
      assert.deepEqual(remaining.rows.map((row) => row.count), [0, 0, 0, 0])
      return { status: 'passed', childRowsRemoved: 4 }
    })

    return {
      status: 'verified',
      cases: {
        catalog,
        duplicateWallet,
        duplicateMigrationName,
        missingProfileUser,
        missingStreamSender,
        missingStreamRecipient,
        missingCallInitiator,
        missingCallRecipient,
        missingConnectionUser,
        nullWalletAddress,
        nullProfileUser,
        nullStreamAssetSymbol,
        nullConnectionWallet,
        cascadeDelete: cascade,
        schemaMigrationIdempotencyRace: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: races }
      },
      cleanupRows: { verifierUsers: 'all prefixed users', schemaMigrations: 'all prefixed records' }
    }
  } finally {
    for (const prefix of prefixes) {
      await withTransaction(pool, async (client) => {
        await client.query('DELETE FROM schema_migrations WHERE migration_name LIKE $1', [`${prefix}%`])
        await client.query('DELETE FROM users WHERE wallet_address LIKE $1', [`${prefix}%`])
      })
    }
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_001_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_001_CONCURRENCY_ATTEMPTS', 4, 2, 16)
  const repetitions = boundedInteger('MIGRATION_001_CONCURRENCY_REPETITIONS', 2, 1, 10)
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
  } finally { await pool.end() }
}

await main()
