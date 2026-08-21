import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

function requiredIsolation() {
  if (process.env.MIGRATION_017_CONTRACT_ISOLATED !== 'true') throw new Error('MIGRATION_017_CONTRACT_ISOLATED=true is required')
  const value = process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL is required')
  const url = new URL(value)
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/(ci|test|testing|disposable|recovery)/.test(databaseName)) {
    throw new Error('migration-017 verifier requires a local disposable database URL')
  }
  return value
}

async function expectSqlState(pool, label, statement, params, sqlState) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let error = null
    try {
      await client.query(statement, params)
    } catch (caught) {
      error = caught
    }
    await client.query('ROLLBACK')
    if (!error) throw new Error(`${label} did not fail`)
    if (error.code !== sqlState) throw new Error(`${label} expected SQLSTATE ${sqlState}, received ${error.code}`)
    return { status: 'passed', sqlState }
  } finally {
    client.release()
  }
}

function hookValues(id, overrides = {}) {
  const base = {
    id,
    owner: '0x1111111111111111111111111111111111111111',
    apiVersion: 'v2',
    contractVersion: '2026-08-15',
    event: 'payment.chain_event_projected',
    callbackUrl: 'https://example.com/paytray-hook',
    projections: JSON.stringify(['identifiers', 'lifecycle']),
    replayWindow: 300,
    delivery: JSON.stringify({ signed: true, retryable: true }),
  }
  return { ...base, ...overrides }
}

function hookParams(id, overrides = {}) {
  const value = hookValues(id, overrides)
  return [value.id, value.owner, value.apiVersion, value.contractVersion, value.event, value.callbackUrl, value.projections, value.replayWindow, value.delivery]
}

function constraintParams(id, overrides = {}) {
  const value = hookValues(id, overrides)
  return [value.id, value.owner, value.contractVersion, value.event, value.callbackUrl, value.projections, value.replayWindow, value.delivery]
}

function nullOwnerParams(id, overrides = {}) {
  const value = hookValues(id, overrides)
  return [value.id, value.apiVersion, value.contractVersion, value.event, value.callbackUrl, value.projections, value.replayWindow, value.delivery]
}

async function insertHook(pool, params) {
  return pool.query(`
    INSERT INTO extension_hooks (
      id, owner_wallet, api_version, contract_version, event, callback_url,
      projections, replay_window_seconds, delivery
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
    RETURNING id, owner_wallet, api_version, replay_window_seconds, active
  `, params)
}

async function main() {
  const connectionString = requiredIsolation()
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 })
  const fixtureIds = []
  const cases = {}
  try {
    const catalog = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'extension_hooks'
        AND indexname = ANY($1::text[])
      ORDER BY indexname
    `, [['extension_hooks_event_active_index', 'extension_hooks_owner_index']])
    const indexes = catalog.rows.map((row) => row.indexname)
    if (indexes.join(',') !== 'extension_hooks_event_active_index,extension_hooks_owner_index') throw new Error('migration-017 expected indexes are missing')
    cases.catalog = { status: 'passed', indexes }

    const validId = `hook-${randomUUID()}`
    fixtureIds.push(validId)
    const valid = await insertHook(pool, hookParams(validId))
    if (valid.rows[0].active !== true || valid.rows[0].api_version !== 'v2' || valid.rows[0].replay_window_seconds !== 300) throw new Error('migration-017 valid hook defaults/invariants did not persist')
    cases.validHook = { status: 'passed', active: valid.rows[0].active, apiVersion: valid.rows[0].api_version, replayWindowSeconds: valid.rows[0].replay_window_seconds }

    const invalidApiId = `hook-${randomUUID()}`
    fixtureIds.push(invalidApiId)
    cases.invalidApiVersion = await expectSqlState(pool, 'invalid API version', `
      INSERT INTO extension_hooks (id, owner_wallet, api_version, contract_version, event, callback_url, projections, replay_window_seconds, delivery)
      VALUES ($1, $2, 'v1', $3, $4, $5, $6::jsonb, $7, $8::jsonb)
    `, constraintParams(invalidApiId), '23514')

    const lowWindowId = `hook-${randomUUID()}`
    fixtureIds.push(lowWindowId)
    cases.lowReplayWindow = await expectSqlState(pool, 'replay window below minimum', `
      INSERT INTO extension_hooks (id, owner_wallet, api_version, contract_version, event, callback_url, projections, replay_window_seconds, delivery)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 59, $8::jsonb)
    `, constraintParams(lowWindowId), '23514')

    const highWindowId = `hook-${randomUUID()}`
    fixtureIds.push(highWindowId)
    cases.highReplayWindow = await expectSqlState(pool, 'replay window above maximum', `
      INSERT INTO extension_hooks (id, owner_wallet, api_version, contract_version, event, callback_url, projections, replay_window_seconds, delivery)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 86401, $8::jsonb)
    `, constraintParams(highWindowId), '23514')

    const nullOwnerId = `hook-${randomUUID()}`
    fixtureIds.push(nullOwnerId)
    cases.requiredOwner = await expectSqlState(pool, 'required owner wallet', `
      INSERT INTO extension_hooks (id, owner_wallet, api_version, contract_version, event, callback_url, projections, replay_window_seconds, delivery)
      VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
    `, nullOwnerParams(nullOwnerId), '23502')

    const raceId = `hook-${randomUUID()}`
    fixtureIds.push(raceId)
    await insertHook(pool, hookParams(raceId))
    const clients = [await pool.connect(), await pool.connect()]
    try {
      const results = await Promise.all(clients.map((client) => client.query(`
        UPDATE extension_hooks
        SET active = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND owner_wallet = $2 AND active = true
        RETURNING id
      `, [raceId, '0x1111111111111111111111111111111111111111'])))
      const returned = results.filter((result) => result.rows.length === 1).length
      if (returned !== 1) throw new Error(`migration-017 deactivation race expected one winner, received ${returned}`)
      cases.deactivationRace = { status: 'passed', attempts: results.length, winners: returned, losers: results.length - returned, activeRows: (await pool.query('SELECT COUNT(*)::int AS count FROM extension_hooks WHERE id = $1 AND active = true', [raceId])).rows[0].count }
    } finally {
      clients.forEach((client) => client.release())
    }
  } finally {
    if (fixtureIds.length) await pool.query('DELETE FROM extension_hooks WHERE id = ANY($1::varchar[])', [fixtureIds])
    await pool.end()
  }

  console.log(JSON.stringify({
    status: 'verified',
    migration: '017_extension_hooks',
    cases,
    cleanupHooks: fixtureIds.length,
    databaseIsolation: true,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
  }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    migration: '017_extension_hooks',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
  }, null, 2))
  process.exitCode = 1
}
