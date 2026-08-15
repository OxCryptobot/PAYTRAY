import assert from 'node:assert/strict'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'

const expectedTables = [
  'users',
  'payment_streams',
  'engagements',
  'payment_intents',
  'payment_chain_events',
  'ledger_accounts',
  'ledger_entries',
  'idempotency_records',
  'outbox_events',
  'financial_audit_events',
  'engagement_outcome_events',
  'ai_feature_snapshots',
  'ai_evaluation_examples',
  'ai_evaluation_runs',
  'ai_shadow_decisions',
  'discovery_impressions',
  'production_telemetry_events',
  'webhook_replay_claims'
]

try {
  await initializeDatabase()
  assert.equal(getDatabaseStatus(), 'ready')

  const result = await transaction((client) => client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [expectedTables]))

  const actualTables = result.rows.map((row) => row.table_name)
  assert.deepEqual(actualTables, [...expectedTables].sort())

  const migrationResult = await transaction((client) => client.query(
    'SELECT migration_name FROM schema_migrations ORDER BY migration_name'
  ))
  assert.deepEqual(
    migrationResult.rows.map((row) => row.migration_name),
    ['001_init', '002_financial_core', '003_discovery_v1', '004_engagement_context', '005_outcomes_and_metrics', '006_ai_evaluation_foundation', '007_discovery_impressions', '008_production_telemetry', '009_verified_outcome_provenance', '010_ledger_intent_idempotency', '011_payment_stream_verifier_provenance', '012_shadow_run_review', '013_verifier_cursors', '014_webhook_replay_claims']
  )

  const ledgerIndexes = await transaction((client) => client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ledger_entries'
      AND indexname = 'ledger_entries_intent_type_unique'
  `))
  assert.deepEqual(ledgerIndexes.rows.map((row) => row.indexname), ['ledger_entries_intent_type_unique'])

  const cursorTable = await transaction((client) => client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'payment_verifier_cursors'
  `))
  assert.deepEqual(cursorTable.rows.map((row) => row.table_name), ['payment_verifier_cursors'])

  const reviewColumns = await transaction((client) => client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_evaluation_runs'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [['reviewer_id', 'reviewer_notes', 'reviewed_at']]))
  assert.deepEqual(reviewColumns.rows.map((row) => row.column_name), ['reviewed_at', 'reviewer_id', 'reviewer_notes'])

  const verifierColumns = await transaction((client) => client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_streams'
      AND column_name = 'last_verified_event'
  `))
  assert.deepEqual(verifierColumns.rows.map((row) => row.column_name), ['last_verified_event'])

  const lifecycleColumns = await transaction((client) => client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_streams'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [['amount_base_units', 'chain_id', 'finality_status', 'lifecycle_state', 'token_address']]))
  assert.deepEqual(
    lifecycleColumns.rows.map((row) => row.column_name),
    ['amount_base_units', 'chain_id', 'finality_status', 'lifecycle_state', 'token_address']
  )

  const outcomeColumns = await transaction((client) => client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'engagement_outcome_events'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [['verification_actor_id', 'verified_at', 'verification_evidence_hash']]))
  assert.deepEqual(
    outcomeColumns.rows.map((row) => row.column_name),
    ['verification_actor_id', 'verification_evidence_hash', 'verified_at']
  )

  const discoveryColumns = await transaction((client) => client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [['availability_status', 'completion_rate', 'languages', 'verification_status']]))
  assert.deepEqual(
    discoveryColumns.rows.map((row) => row.column_name),
    ['availability_status', 'completion_rate', 'languages', 'verification_status']
  )

  console.log(JSON.stringify({
    status: 'ok',
    databaseStatus: getDatabaseStatus(),
    migrationNames: migrationResult.rows.map((row) => row.migration_name),
    financialCoreTables: actualTables,
    discoveryColumns: discoveryColumns.rows.map((row) => row.column_name),
    outcomeVerificationColumns: outcomeColumns.rows.map((row) => row.column_name),
    ledgerIndexes: ledgerIndexes.rows.map((row) => row.indexname),
    verifierColumns: verifierColumns.rows.map((row) => row.column_name),
    reviewColumns: reviewColumns.rows.map((row) => row.column_name),
    cursorTable: cursorTable.rows.map((row) => row.table_name)
  }, null, 2))
} finally {
  await closeDatabase()
}
