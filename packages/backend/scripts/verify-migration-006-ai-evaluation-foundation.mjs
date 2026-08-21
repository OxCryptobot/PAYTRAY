import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '006_ai_evaluation_foundation'
const DATABASE_URL = process.env.MIGRATION_006_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_006_CONTRACT_ISOLATED === 'true'

function json(value) { return JSON.stringify(value, null, 2) }

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_006_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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
  const tables = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name
  `, [['ai_evaluation_examples', 'ai_evaluation_runs', 'ai_feature_snapshots', 'ai_shadow_decisions']])
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    'ai_evaluation_examples', 'ai_evaluation_runs', 'ai_feature_snapshots', 'ai_shadow_decisions'
  ])

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('ai_feature_snapshots_entity_time_index', 'ai_evaluation_examples_dataset_index', 'ai_shadow_decisions_entity_index')
     ORDER BY indexname
  `)
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'ai_evaluation_examples_dataset_index',
    'ai_feature_snapshots_entity_time_index',
    'ai_shadow_decisions_entity_index'
  ])

  const checks = await client.query(`
    SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND conrelid::regclass::text IN ('ai_feature_snapshots', 'ai_evaluation_examples', 'ai_evaluation_runs', 'ai_shadow_decisions')
       AND contype = 'c'
     ORDER BY table_name, conname
  `)
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_feature_snapshots' && /entity_type/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_feature_snapshots' && /privacy_class/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_evaluation_examples' && /label_type/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_evaluation_examples' && /split/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_evaluation_runs' && /reviewer_decision/i.test(row.definition) && /approved_pilot/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_shadow_decisions' && /confidence/i.test(row.definition)))
  assert.ok(checks.rows.some((row) => row.table_name === 'ai_shadow_decisions' && /applied/i.test(row.definition)))

  const unique = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'public.ai_evaluation_examples'::regclass AND contype = 'u'
  `)
  assert.ok(unique.rows.some((row) => /dataset_version/i.test(row.definition) && /query_id/i.test(row.definition) && /candidate_profile_id/i.test(row.definition) && /split/i.test(row.definition)))
  return { status: 'passed', tables: tables.rows.map((row) => row.table_name), indexes: indexes.rows.map((row) => row.indexname), checkCount: checks.rows.length, evaluationExampleUniqueConstraint: true }
}

async function createFixture(client, suffix) {
  const users = await client.query('INSERT INTO users (wallet_address) VALUES ($1), ($2) RETURNING id', [`migration006-client-${suffix}`, `migration006-provider-${suffix}`])
  const profile = await client.query('INSERT INTO profiles (user_id, is_expert) VALUES ($1, true) RETURNING id', [users.rows[1].id])
  const evaluationRun = await client.query(`
    INSERT INTO ai_evaluation_runs (task_type, model_name, model_version, baseline_version, dataset_version, time_split)
    VALUES ('ranking', 'paytray-shadow-verifier', 'v1', 'baseline-v1', $1, $2)
    RETURNING id, status, reviewer_decision
  `, [`dataset-${suffix}`, JSON.stringify({ asOf: '2026-08-20T00:00:00.000Z' })])
  return { userIds: users.rows.map((row) => row.id), profileId: profile.rows[0].id, evaluationRunId: evaluationRun.rows[0].id, datasetVersion: `dataset-${suffix}`, evaluationRun: evaluationRun.rows[0] }
}

async function insertEvaluationExample(client, fixture, queryId, split = 'shadow', labelValue = 1) {
  return client.query(`
    INSERT INTO ai_evaluation_examples (
      dataset_version, query_id, candidate_profile_id, label_type, label_value,
      label_verification_status, split, as_of
    ) VALUES ($1, $2, $3, 'selected', $4, 'verified', $5, '2026-08-20T00:00:00.000Z')
    RETURNING id, dataset_version, query_id, split, provenance
  `, [fixture.datasetVersion, queryId, fixture.profileId, labelValue, split])
}

async function exampleRace(pool, fixture, queryId, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertEvaluationExample(client, fixture, queryId))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, 'exactly one duplicate evaluation-example writer must commit')
  assert.equal(losers.length, attempts - 1, 'all remaining duplicate evaluation-example writers must reject')
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), 'every duplicate evaluation-example loser must return SQLSTATE 23505')
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const queryIds = []
  const profileIds = []
  const userIds = []
  const evaluationRunIds = []
  const snapshotIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    profileIds.push(fixture.profileId)
    userIds.push(...fixture.userIds)
    evaluationRunIds.push(fixture.evaluationRunId)

    const snapshot = await withTransaction(pool, (client) => client.query(`
      INSERT INTO ai_feature_snapshots (entity_type, entity_id, feature_version, as_of, features, retention_until, source_hash)
      VALUES ('expert_profile', $1, 'features-v1', '2026-08-20T00:00:00.000Z', $2, '2026-09-20T00:00:00.000Z', $3)
      RETURNING id, source_event_ids, privacy_class
    `, [fixture.profileId, JSON.stringify({ paidMinutes: 10 }), 'a'.repeat(64)]))
    snapshotIds.push(snapshot.rows[0].id)
    assert.deepEqual(snapshot.rows[0].source_event_ids, [])
    assert.equal(snapshot.rows[0].privacy_class, 'derived_non_content')

    const queryId = `migration006-query-${Date.now()}-${Math.random().toString(16).slice(2)}`
    queryIds.push(queryId)
    const example = await withTransaction(pool, (client) => insertEvaluationExample(client, fixture, queryId))
    assert.deepEqual(example.rows[0].provenance, {})
    const shadow = await withTransaction(pool, (client) => client.query(`
      INSERT INTO ai_shadow_decisions (evaluation_run_id, task_type, entity_type, entity_id, model_version, input_hash, output, confidence)
      VALUES ($1, 'ranking', 'expert_profile', $2, 'v1', $3, $4, 0.75)
      RETURNING applied, human_review_status
    `, [fixture.evaluationRunId, fixture.profileId, 'b'.repeat(64), JSON.stringify({ rank: 1 })]))
    assert.deepEqual(shadow.rows[0], { applied: false, human_review_status: 'not_reviewed' })

    const duplicate = await expectSqlState(pool, 'duplicate evaluation example', '23505', (client) => insertEvaluationExample(client, fixture, queryId))
    const invalidConfidence = await expectSqlState(pool, 'out-of-range shadow confidence', '23514', (client) => client.query(`
      INSERT INTO ai_shadow_decisions (task_type, entity_type, entity_id, model_version, input_hash, output, confidence)
      VALUES ('ranking', 'expert_profile', $1, 'v1', $2, '{}'::jsonb, 1.01)
    `, [fixture.profileId, 'c'.repeat(64)]))
    const appliedWithoutReview = await expectSqlState(pool, 'applied shadow decision without human review', '23514', (client) => client.query(`
      INSERT INTO ai_shadow_decisions (task_type, entity_type, entity_id, model_version, input_hash, output, applied)
      VALUES ('ranking', 'expert_profile', $1, 'v1', $2, '{}'::jsonb, true)
    `, [fixture.profileId, 'd'.repeat(64)]))

    const raceRuns = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const raceQueryId = `migration006-race-${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`
      queryIds.push(raceQueryId)
      raceRuns.push(await exampleRace(pool, fixture, raceQueryId, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        defaults: { status: 'passed', featureSourceEventIds: [], featurePrivacyClass: 'derived_non_content', evaluationExampleProvenance: {}, shadowApplied: false, shadowHumanReviewStatus: 'not_reviewed' },
        duplicateEvaluationExample: duplicate,
        invalidConfidence,
        appliedWithoutHumanReview: appliedWithoutReview,
        concurrentDuplicateEvaluationExample: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, validRuns: raceRuns.length, runs: raceRuns }
      },
      cleanupRows: { examples: queryIds.length, snapshots: snapshotIds.length, evaluationRuns: evaluationRunIds.length, profiles: profileIds.length, users: userIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM ai_shadow_decisions WHERE evaluation_run_id = ANY($1::uuid[])', [evaluationRunIds])
      await client.query('DELETE FROM ai_evaluation_examples WHERE query_id = ANY($1::varchar[])', [queryIds])
      await client.query('DELETE FROM ai_feature_snapshots WHERE id = ANY($1::uuid[])', [snapshotIds])
      await client.query('DELETE FROM ai_evaluation_runs WHERE id = ANY($1::uuid[])', [evaluationRunIds])
      await client.query('DELETE FROM profiles WHERE id = ANY($1::uuid[])', [profileIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_006_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_006_CONCURRENCY_ATTEMPTS', 8, 2, 16)
  const repetitions = boundedInteger('MIGRATION_006_CONCURRENCY_REPETITIONS', 3, 1, 10)
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
