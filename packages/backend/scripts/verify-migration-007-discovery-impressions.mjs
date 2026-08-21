import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '007_discovery_impressions'
const DATABASE_URL = process.env.MIGRATION_007_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_007_CONTRACT_ISOLATED === 'true'

function json(value) { return JSON.stringify(value, null, 2) }

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_007_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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
     WHERE table_schema = 'public' AND table_name = 'discovery_impressions'
     ORDER BY ordinal_position
  `)
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    'id', 'query_id', 'client_id', 'candidate_profile_id', 'engagement_id', 'rank_position',
    'baseline_score', 'ranking_version', 'query_features', 'match_explanation', 'selected',
    'observed_at', 'provenance'
  ])

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'discovery_impressions'
       AND indexname IN ('discovery_impressions_query_index', 'discovery_impressions_profile_index')
     ORDER BY indexname
  `)
  assert.deepEqual(indexes.rows.map((row) => row.indexname), ['discovery_impressions_profile_index', 'discovery_impressions_query_index'])

  const constraints = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.discovery_impressions'::regclass AND contype = 'c'
     ORDER BY conname
  `)
  assert.equal(constraints.rows.length, 2)
  assert.ok(constraints.rows.some((row) => /rank_position > 0/i.test(row.definition)))
  assert.ok(constraints.rows.some((row) => /baseline_score/i.test(row.definition) && /baseline_score\s*>=.*0/i.test(row.definition) && /baseline_score\s*<=.*100/i.test(row.definition)))
  return { status: 'passed', columnCount: columns.rows.length, indexes: indexes.rows.map((row) => row.indexname), checkCount: constraints.rows.length }
}

async function createFixture(client, suffix) {
  const users = await client.query('INSERT INTO users (wallet_address) VALUES ($1), ($2) RETURNING id', [`migration007-client-${suffix}`, `migration007-provider-${suffix}`])
  const profile = await client.query('INSERT INTO profiles (user_id, is_expert) VALUES ($1, true) RETURNING id', [users.rows[1].id])
  return { userIds: users.rows.map((row) => row.id), profileId: profile.rows[0].id }
}

async function insertImpression(client, fixture, queryId, rankPosition = 1, baselineScore = 42.5) {
  return client.query(`
    INSERT INTO discovery_impressions (
      query_id, client_id, candidate_profile_id, rank_position, baseline_score, ranking_version
    ) VALUES ($1, $2, $3, $4, $5, 'ranking-v1')
    RETURNING id, query_id, rank_position, baseline_score, query_features, match_explanation, provenance
  `, [queryId, fixture.userIds[0], fixture.profileId, rankPosition, baselineScore])
}

async function impressionRace(pool, fixture, queryId, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertImpression(client, fixture, queryId))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one duplicate impression writer must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining duplicate impression writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'every duplicate impression loser must return SQLSTATE 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const queryIds = []
  const profileIds = []
  const userIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    profileIds.push(fixture.profileId)
    userIds.push(...fixture.userIds)
    const queryId = `migration007-query-${Date.now()}-${Math.random().toString(16).slice(2)}`
    queryIds.push(queryId)
    const valid = await withTransaction(pool, (client) => insertImpression(client, fixture, queryId))
    assert.deepEqual(valid.rows[0].query_features, {})
    assert.deepEqual(valid.rows[0].match_explanation, {})
    assert.deepEqual(valid.rows[0].provenance, {})

    const duplicate = await expectSqlState(pool, 'duplicate query and candidate impression', '23505', (client) => insertImpression(client, fixture, queryId))
    const invalidRank = await expectSqlState(pool, 'nonpositive impression rank', '23514', (client) => insertImpression(client, fixture, `invalid-rank-${Date.now()}`, 0))
    const invalidScore = await expectSqlState(pool, 'out-of-range impression baseline score', '23514', (client) => insertImpression(client, fixture, `invalid-score-${Date.now()}`, 1, 100.01))

    const raceRuns = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const raceFixture = await withTransaction(pool, (client) => createFixture(client, `race-${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`))
      profileIds.push(raceFixture.profileId)
      userIds.push(...raceFixture.userIds)
      const raceQueryId = `migration007-race-${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`
      queryIds.push(raceQueryId)
      raceRuns.push(await impressionRace(pool, raceFixture, raceQueryId, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        defaults: { status: 'passed', queryFeatures: {}, matchExplanation: {}, provenance: {} },
        duplicateQueryCandidate: duplicate,
        invalidRank,
        invalidScore,
        concurrentDuplicateQueryCandidate: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: raceRuns.length, runs: raceRuns }
      },
      cleanupRows: { impressions: queryIds.length, profiles: profileIds.length, users: userIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM discovery_impressions WHERE query_id = ANY($1::varchar[])', [queryIds])
      await client.query('DELETE FROM profiles WHERE id = ANY($1::uuid[])', [profileIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_007_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_007_CONCURRENCY_ATTEMPTS', 8, 2, 16)
  const repetitions = boundedInteger('MIGRATION_007_CONCURRENCY_REPETITIONS', 3, 1, 10)
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
