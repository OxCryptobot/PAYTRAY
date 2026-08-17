import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg

function fail(message) {
  throw new Error(message)
}

function requiredIsolation() {
  if (process.env.MIGRATION_015_CONTRACT_ISOLATED !== 'true') fail('MIGRATION_015_CONTRACT_ISOLATED=true is required')
  const value = process.env.DATABASE_URL
  if (!value) fail('DATABASE_URL is required')
  const url = new URL(value)
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/(ci|test|testing|disposable|recovery|restore|attestation)/.test(databaseName)) {
    fail('migration-015 verifier requires a local disposable database URL')
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
    if (!error) fail(`${label} did not fail`)
    if (error.code !== sqlState) fail(`${label} expected SQLSTATE ${sqlState}, received ${error.code}`)
    return { status: 'passed', sqlState }
  } finally {
    client.release()
  }
}

function signalParams({ userId, engagementId, outcomeId, signalType = 'contract_signal', overrides = {} }) {
  const values = [
    userId,
    '0x015contractwallet',
    engagementId,
    outcomeId,
    signalType,
    'positive',
    3,
    false,
    'a'.repeat(64),
    JSON.stringify({ source: 'verified_outcome', verificationSource: 'verifier', eligibleForRanking: false, authority: 'verified_outcome_evidence', mutation: 'read_only' })
  ]
  return values.map((value, index) => overrides[index] === undefined ? value : overrides[index])
}

async function expectSignalInsert(pool, label, params, sqlState) {
  return expectSqlState(pool, label, `
    INSERT INTO verified_trust_signals (
      subject_user_id, subject_wallet_address, engagement_id, outcome_id,
      signal_type, polarity, score, eligible_for_ranking, evidence_hash, provenance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
  `, params, sqlState)
}

async function createFixtures(pool) {
  const suffix = randomUUID().slice(0, 8)
  const clientUser = await pool.query(`
    INSERT INTO users (wallet_address, wallet_type, is_active)
    VALUES ($1, 'injected', true)
    RETURNING id
  `, [`0x015client${suffix}`])
  const providerUser = await pool.query(`
    INSERT INTO users (wallet_address, wallet_type, is_active)
    VALUES ($1, 'injected', true)
    RETURNING id
  `, [`0x015provider${suffix}`])
  const clientId = clientUser.rows[0].id
  const providerId = providerUser.rows[0].id
  const engagement = await pool.query(`
    INSERT INTO engagements (client_id, provider_id, status, scope)
    VALUES ($1, $2, 'active', 'Migration 015 disposable contract fixture')
    RETURNING id
  `, [clientId, providerId])
  const engagementId = engagement.rows[0].id
  const outcome = await pool.query(`
    INSERT INTO engagement_outcome_events (
      engagement_id, event_type, actor_type, actor_id, evidence_type, evidence_id,
      payload, verification_status, provenance, occurred_at
    ) VALUES ($1, 'meeting_completed', 'verifier', 'migration-015-contract', 'session', $2,
      '{}'::jsonb, 'verified', $3::jsonb, CURRENT_TIMESTAMP)
    RETURNING id
  `, [engagementId, `migration-015-${suffix}`, JSON.stringify({ verificationSource: 'verifier', verificationEvidenceHash: 'a'.repeat(64) })])
  return {
    clientId,
    providerId,
    engagementId,
    outcomeId: outcome.rows[0].id
  }
}

async function catalogChecks(pool) {
  const constraints = await pool.query(`
    SELECT child_attr.attname AS child_column, parent.relname AS parent_table
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, position) ON true
    JOIN pg_attribute child_attr ON child_attr.attrelid = child.oid AND child_attr.attnum = child_key.attnum
    WHERE constraint_row.contype = 'f'
      AND child.relname = 'verified_trust_signals'
    ORDER BY child_column
  `)
  const actualForeignKeys = constraints.rows.map((row) => `${row.child_column}->${row.parent_table}`)
  const expectedForeignKeys = [
    'engagement_id->engagements',
    'outcome_id->engagement_outcome_events',
    'subject_user_id->users'
  ]
  if (actualForeignKeys.join('|') !== expectedForeignKeys.join('|')) fail(`migration-015 foreign keys mismatch: ${actualForeignKeys.join(', ')}`)

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'verified_trust_signals'
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [['verified_trust_signals_outcome_index', 'verified_trust_signals_subject_index']])
  const actualIndexes = indexes.rows.map((row) => row.indexname)
  if (actualIndexes.join('|') !== 'verified_trust_signals_outcome_index|verified_trust_signals_subject_index') fail(`migration-015 indexes mismatch: ${actualIndexes.join(', ')}`)
  return { status: 'passed', foreignKeys: actualForeignKeys, indexes: actualIndexes }
}

async function main() {
  const connectionString = requiredIsolation()
  const pool = new Pool({ connectionString, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  let fixtures = null
  let cleanupPerformed = false
  const cases = {}
  try {
    cases.catalog = await catalogChecks(pool)
    fixtures = await createFixtures(pool)

    const validInsert = await pool.query(`
      INSERT INTO verified_trust_signals (
        subject_user_id, subject_wallet_address, engagement_id, outcome_id,
        signal_type, polarity, score, evidence_hash, provenance
      ) VALUES ($1, $2, $3, $4, $5, 'positive', 3, $6, $7::jsonb)
      RETURNING id, eligible_for_ranking, polarity, score
    `, [fixtures.providerId, '0x015contractwallet', fixtures.engagementId, fixtures.outcomeId, 'valid_contract_signal', 'a'.repeat(64), JSON.stringify({ source: 'verified_outcome', verificationSource: 'verifier', eligibleForRanking: false, authority: 'verified_outcome_evidence', mutation: 'read_only' })])
    if (!validInsert.rows[0] || validInsert.rows[0].eligible_for_ranking !== false || validInsert.rows[0].polarity !== 'positive' || validInsert.rows[0].score !== 3) {
      fail('migration-015 valid trust signal did not persist the immutable defaults')
    }
    cases.validSignal = { status: 'passed', eligibleForRanking: false, polarity: 'positive', score: 3 }

    cases.foreignKeys = {}
    const invalidUser = randomUUID()
    const invalidEngagement = randomUUID()
    const invalidOutcome = randomUUID()
    cases.foreignKeys.subjectUser = await expectSignalInsert(pool, 'subject_user foreign key', signalParams({ userId: invalidUser, engagementId: fixtures.engagementId, outcomeId: fixtures.outcomeId }), '23503')
    cases.foreignKeys.engagement = await expectSignalInsert(pool, 'engagement foreign key', signalParams({ userId: fixtures.providerId, engagementId: invalidEngagement, outcomeId: fixtures.outcomeId, signalType: 'invalid_engagement' }), '23503')
    cases.foreignKeys.outcome = await expectSignalInsert(pool, 'outcome foreign key', signalParams({ userId: fixtures.providerId, engagementId: fixtures.engagementId, outcomeId: invalidOutcome, signalType: 'invalid_outcome' }), '23503')

    cases.polarity = await expectSignalInsert(pool, 'invalid polarity', signalParams({ userId: fixtures.providerId, engagementId: fixtures.engagementId, outcomeId: fixtures.outcomeId, signalType: 'invalid_polarity', overrides: { 5: 'negative' } }), '23514')
    cases.score = await expectSignalInsert(pool, 'negative score', signalParams({ userId: fixtures.providerId, engagementId: fixtures.engagementId, outcomeId: fixtures.outcomeId, signalType: 'negative_score', overrides: { 6: -1 } }), '23514')
    cases.rankingEligibility = await expectSignalInsert(pool, 'ranking eligibility promotion', signalParams({ userId: fixtures.providerId, engagementId: fixtures.engagementId, outcomeId: fixtures.outcomeId, signalType: 'ranking_promotion', overrides: { 7: true } }), '23514')
    cases.uniqueness = await expectSignalInsert(pool, 'duplicate trust signal', signalParams({ userId: fixtures.providerId, engagementId: fixtures.engagementId, outcomeId: fixtures.outcomeId, signalType: 'valid_contract_signal' }), '23505')
  } finally {
    if (fixtures) {
      await pool.query('DELETE FROM verified_trust_signals WHERE engagement_id = $1 OR outcome_id = $2', [fixtures.engagementId, fixtures.outcomeId])
      await pool.query('DELETE FROM engagement_outcome_events WHERE id = $1', [fixtures.outcomeId])
      await pool.query('DELETE FROM engagements WHERE id = $1', [fixtures.engagementId])
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[fixtures.clientId, fixtures.providerId]])
      cleanupPerformed = true
    }
    await pool.end()
  }

  console.log(JSON.stringify({
    status: 'verified',
    migration: '015_verified_trust_signals',
    cases,
    databaseIsolation: true,
    cleanupPerformed,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    code: error.code || null,
    migration: '015_verified_trust_signals',
    databaseIsolation: true,
    cleanupPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
