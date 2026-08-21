import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_013_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_013_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_013_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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

async function insertCursor(client, chainId, lastScannedBlock, updatedAt = '2026-08-20T00:00:00.000Z') {
  await client.query(`
    INSERT INTO payment_verifier_cursors (chain_id, last_scanned_block, updated_at)
    VALUES ($1, $2, $3)
  `, [chainId, lastScannedBlock, updatedAt])
}

async function verifyCatalog(client) {
  const columns = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payment_verifier_cursors'
     ORDER BY ordinal_position
  `)
  assert.deepEqual(columns.rows.map((row) => row.column_name), ['chain_id', 'last_scanned_block', 'updated_at'])

  const primaryKey = await client.query(`
    SELECT constraint_name
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'payment_verifier_cursors'
       AND constraint_type = 'PRIMARY KEY'
  `)
  assert.equal(primaryKey.rows.length, 1)

  const checks = await client.query(`
    SELECT constraint_name
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'payment_verifier_cursors'
       AND constraint_type = 'CHECK'
       AND constraint_name = 'payment_verifier_cursors_last_scanned_block_check'
  `)
  assert.equal(checks.rows.length, 1)
  return {
    status: 'passed',
    columns: columns.rows.map((row) => row.column_name),
    primaryKeyCount: primaryKey.rows.length,
    checkCount: checks.rows.length
  }
}

async function runContractSuite(pool) {
  const chainIds = new Set()
  const results = {}
  try {
    results.catalog = await withTransaction(pool, (client) => verifyCatalog(client))

    const negativeChain = 900000000000000000n + BigInt(Math.floor(Math.random() * 1000000))
    chainIds.add(negativeChain.toString())
    results.negativeBlock = await expectSqlState(pool, 'negative last scanned block', '23514', (client) => insertCursor(client, negativeChain.toString(), -1))

    const nullBlockChain = (negativeChain + 1n).toString()
    chainIds.add(nullBlockChain)
    results.nullBlock = await expectSqlState(pool, 'null last scanned block', '23502', (client) => insertCursor(client, nullBlockChain, null))

    const duplicateChain = (negativeChain + 2n).toString()
    chainIds.add(duplicateChain)
    await withTransaction(pool, (client) => insertCursor(client, duplicateChain, 100))
    results.duplicateChain = await expectSqlState(pool, 'duplicate chain cursor', '23505', (client) => insertCursor(client, duplicateChain, 101))

    const validChain = (negativeChain + 3n).toString()
    chainIds.add(validChain)
    await withTransaction(pool, (client) => insertCursor(client, validChain, 8453200))
    const valid = await withTransaction(pool, (client) => client.query('SELECT chain_id, last_scanned_block, updated_at FROM payment_verifier_cursors WHERE chain_id = $1', [validChain]))
    assert.equal(valid.rows[0].last_scanned_block, '8453200')
    results.validCursor = { status: 'passed', chainId: validChain, lastScannedBlock: Number(valid.rows[0].last_scanned_block), updatedAtPresent: Boolean(valid.rows[0].updated_at) }

    return { status: 'verified', cases: results, cleanupChainIds: chainIds.size }
  } finally {
    const ids = [...chainIds]
    await withTransaction(pool, (client) => client.query('DELETE FROM payment_verifier_cursors WHERE chain_id = ANY($1::bigint[])', [ids]))
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_013_CONTRACT_ISOLATED=true is required', migration: '013_verifier_cursors', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({ ...report, migration: '013_verifier_cursors', databaseIsolation: true, cleanupPerformed: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: '013_verifier_cursors', databaseIsolation: true, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
