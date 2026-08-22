import fs from 'node:fs'
import path from 'node:path'

const repositoryPath = process.env.PAYTRAY_REPOSITORY_PATH ?? process.argv[2] ?? process.cwd()
const outputPath = process.env.POSTGRES_ASSERTION_TRACEABILITY_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-postgres-assertion-traceability.json'

const migrations = [
  {
    migration: '001_init',
    sqlFile: 'packages/backend/migrations/001_init.sql',
    verifier: 'packages/backend/scripts/verify-migration-001-bootstrap.mjs',
    tableMatchers: ['users', 'profiles', 'payment_streams', 'video_calls', 'wallet_connections', 'schema_migrations'],
    caseStates: {
      duplicateWallet: '23505',
      duplicateMigrationName: '23505',
      missingProfileUser: '23503',
      missingStreamSender: '23503',
      missingStreamRecipient: '23503',
      missingCallInitiator: '23503',
      missingCallRecipient: '23503',
      missingConnectionUser: '23503',
      nullWalletAddress: '23502',
      nullProfileUser: '23502',
      nullStreamAssetSymbol: '23502',
      nullConnectionWallet: '23502'
    },
    raceCases: ['bootstrapIdempotencyRace'],
    sqlMatchers: [
      /CREATE TABLE IF NOT EXISTS users/i,
      /wallet_address VARCHAR\(255\) UNIQUE NOT NULL/i,
      /REFERENCES users\(id\) ON DELETE CASCADE/i,
      /migration_name VARCHAR\(255\) UNIQUE NOT NULL/i
    ]
  },
  {
    migration: '002_financial_core',
    sqlFile: 'packages/backend/migrations/002_financial_core.sql',
    verifier: 'packages/backend/scripts/verify-migration-002-financial-core.mjs',
    tableMatchers: ['engagements', 'payment_intents', 'payment_chain_events', 'ledger_accounts', 'ledger_entries', 'idempotency_records', 'outbox_events', 'financial_audit_events'],
    caseStates: {
      duplicateSenderIdempotency: '23505',
      duplicateTransactionHash: '23505',
      sameEngagementUsers: '23514',
      invalidEngagementStatus: '23514',
      sameIntentUsers: '23514',
      invalidDecimals: '23514',
      negativeAmount: '23514',
      duplicateProtocolStream: '23505',
      negativeConfirmation: '23514',
      invalidFinality: '23514',
      duplicateChainIdentity: '23505',
      sameLedgerAccounts: '23514',
      zeroLedgerAmount: '23514',
      missingLedgerProvenance: '23514',
      duplicateLedgerEventType: '23505',
      duplicateLedgerAccount: '23505',
      duplicateIdempotency: '23505',
      negativeOutboxAttempts: '23514',
      invalidAuditActor: '23514'
    },
    raceCases: ['paymentIntentRace', 'chainEventRace', 'ledgerEventRace', 'idempotencyRecordRace'],
    sqlMatchers: [
      /CREATE TABLE IF NOT EXISTS engagements/i,
      /CHECK \(client_id <> provider_id\)/i,
      /UNIQUE \(sender_id, idempotency_key\)/i,
      /UNIQUE \(transaction_hash\)/i,
      /CREATE UNIQUE INDEX IF NOT EXISTS payment_streams_protocol_identity_unique/i,
      /CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_event_type_unique/i,
      /UNIQUE \(scope, idempotency_key\)/i
    ]
  },
  {
    migration: '003_discovery_v1',
    sqlFile: 'packages/backend/migrations/003_discovery_v1.sql',
    verifier: 'packages/backend/scripts/verify-migration-003-discovery-v1.mjs',
    tableMatchers: ['profiles'],
    caseStates: {
      nullAvailability: '23502',
      nullLanguages: '23502',
      nullVerification: '23502',
      nullEvidenceLinks: '23502',
      nullCompletionRate: '23502',
      nullRepeatBookingRate: '23502',
      nullPaidMinutes: '23502',
      nullDisputesCount: '23502'
    },
    raceCases: [],
    noRaceReason: 'not_applicable: migration-003 adds profile columns and indexes but defines no unique, CHECK, or state-transition constraint for a concurrency race',
    sqlMatchers: [
      /ADD COLUMN IF NOT EXISTS availability_status VARCHAR\(32\) NOT NULL DEFAULT 'unknown'/i,
      /ADD COLUMN IF NOT EXISTS languages TEXT\[\] NOT NULL DEFAULT '\{\}'/i,
      /ADD COLUMN IF NOT EXISTS verification_status VARCHAR\(32\) NOT NULL DEFAULT 'unverified'/i,
      /ADD COLUMN IF NOT EXISTS evidence_links JSONB NOT NULL DEFAULT '\[\]'::jsonb/i,
      /ADD COLUMN IF NOT EXISTS completion_rate NUMERIC\(6, 5\) NOT NULL DEFAULT 0/i,
      /ADD COLUMN IF NOT EXISTS disputes_count INTEGER NOT NULL DEFAULT 0/i,
      /CREATE INDEX IF NOT EXISTS profiles_expertise_gin_idx/i,
      /CREATE INDEX IF NOT EXISTS profiles_outcome_idx/i
    ]
  },
  {
    migration: '004_engagement_context',
    sqlFile: 'packages/backend/migrations/004_engagement_context.sql',
    verifier: 'packages/backend/scripts/verify-migration-004-engagement-context.mjs',
    tableMatchers: ['engagements'],
    caseStates: {
      invalidCollaboration: '23514',
      invalidPayment: '23514',
      nullCollaboration: '23502',
      nullPayment: '23502',
      nullDiscoveryContext: '23502',
      nullRankingExplanation: '23502',
      invalidContextVersion: '23502'
    },
    raceCases: ['stateUpdateRace'],
    sqlMatchers: [
      /ADD COLUMN IF NOT EXISTS discovery_context JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
      /ADD COLUMN IF NOT EXISTS ranking_explanation JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
      /ADD COLUMN IF NOT EXISTS collaboration_status VARCHAR\(32\) NOT NULL DEFAULT 'not_started'/i,
      /ADD COLUMN IF NOT EXISTS payment_status VARCHAR\(32\) NOT NULL DEFAULT 'not_requested'/i,
      /ADD CONSTRAINT engagements_collaboration_status_check CHECK/i,
      /ADD CONSTRAINT engagements_payment_status_check CHECK/i,
      /CREATE INDEX IF NOT EXISTS engagements_participant_status_index/i,
      /CREATE INDEX IF NOT EXISTS engagements_thread_index/i
    ]
  },
  {
    migration: '005_outcomes_and_metrics',
    sqlFile: 'packages/backend/migrations/005_outcomes_and_metrics.sql',
    verifier: 'packages/backend/scripts/verify-migration-005-outcome-lineage.mjs',
    tableMatchers: ['engagement_outcome_events'],
    caseStates: {
      duplicateIdentity: '23505',
      invalidEventType: '23514',
      invalidActorType: '23514',
      invalidReviewState: '23514',
      invalidEvidenceType: '23514',
      missingEngagement: '23503',
      nullOccurredAt: '23502',
      nullEventType: '23502',
      nullActorType: '23502'
    },
    raceCases: ['duplicateOutcomeRace', 'verifierTransitionRace'],
    sqlMatchers: [
      /CREATE TABLE IF NOT EXISTS engagement_outcome_events/i,
      /engagement_id UUID NOT NULL REFERENCES engagements\(id\) ON DELETE RESTRICT/i,
      /CHECK \(event_type IN \(/i,
      /CHECK \(actor_type IN \(/i,
      /CHECK \(verification_status IN \(/i,
      /CHECK \(evidence_type IN \(/i,
      /UNIQUE \(engagement_id, event_type, evidence_type, evidence_id\)/i,
      /CREATE INDEX IF NOT EXISTS engagement_outcome_events_metric_index/i,
      /CREATE INDEX IF NOT EXISTS engagement_outcome_events_engagement_index/i
    ]
  },
  {
    migration: '006_ai_evaluation_foundation',
    sqlFile: 'packages/backend/migrations/006_ai_evaluation_foundation.sql',
    verifier: 'packages/backend/scripts/verify-migration-006-ai-evaluation-foundation.mjs',
    tableMatchers: ['ai_feature_snapshots', 'ai_evaluation_examples', 'ai_evaluation_runs', 'ai_shadow_decisions'],
    caseStates: { duplicateEvaluationExample: '23505', invalidConfidence: '23514', appliedWithoutHumanReview: '23514' },
    raceCases: ['concurrentDuplicateEvaluationExample'],
    sqlMatchers: [
      /UNIQUE \(entity_type, entity_id, feature_version, as_of\)/i,
      /UNIQUE \(dataset_version, query_id, candidate_profile_id, split\)/i,
      /CHECK \(confidence IS NULL OR \(confidence >= 0 AND confidence <= 1\)\)/i,
      /CHECK \(applied = false OR human_review_status IN \('accepted', 'edited'\)\)/i
    ]
  },
  {
    migration: '007_discovery_impressions',
    sqlFile: 'packages/backend/migrations/007_discovery_impressions.sql',
    verifier: 'packages/backend/scripts/verify-migration-007-discovery-impressions.mjs',
    tableMatchers: ['discovery_impressions'],
    caseStates: { duplicateQueryCandidate: '23505', invalidRank: '23514', invalidScore: '23514' },
    raceCases: ['concurrentDuplicateQueryCandidate'],
    sqlMatchers: [/CHECK \(rank_position > 0\)/i, /CHECK \(baseline_score >= 0 AND baseline_score <= 100\)/i, /UNIQUE \(query_id, candidate_profile_id\)/i]
  },
  {
    migration: '008_production_telemetry',
    sqlFile: 'packages/backend/migrations/008_production_telemetry.sql',
    verifier: 'packages/backend/scripts/verify-migration-008-production-telemetry.mjs',
    tableMatchers: ['production_telemetry_events'],
    caseStates: { duplicateEventId: '23505', invalidEventType: '23514', invalidPrivacyClass: '23514' },
    raceCases: ['concurrentDuplicateEventId'],
    sqlMatchers: [/CHECK \(event_type IN \(/i, /CHECK \(privacy_class IN \(/i, /UNIQUE \(event_id\)/i]
  },
  {
    migration: '009_verified_outcome_provenance',
    sqlFile: 'packages/backend/migrations/009_verified_outcome_provenance.sql',
    verifier: 'packages/backend/scripts/verify-migration-009-verified-outcome-provenance.mjs',
    tableMatchers: ['engagement_outcome_events', 'engagement_outcome_events_verified_index'],
    caseStates: { invalidStatus: '23514', oversizedHash: '22001' },
    raceCases: [],
    noRaceReason: 'not_applicable: migration-009 adds nullable provenance columns and an index; it defines no unique, CHECK, or state-transition boundary for a concurrency race',
    sqlMatchers: [
      /ADD COLUMN IF NOT EXISTS verification_actor_id VARCHAR\(255\)/i,
      /ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP/i,
      /ADD COLUMN IF NOT EXISTS verification_evidence_hash VARCHAR\(64\)/i,
      /CREATE INDEX IF NOT EXISTS engagement_outcome_events_verified_index/i
    ]
  }
]

const errors = []
const results = []
const requiredSafetyFields = ['releaseEligible: false', 'settlementAuthority: false', "mutation: 'read_only'", 'deploymentPerformed: false', 'settlementMutationPerformed: false']
const expectedSqlStateLiterals = [...new Set(migrations.flatMap((migration) => Object.values(migration.caseStates)))]

for (const migration of migrations) {
  const sqlPath = path.join(repositoryPath, migration.sqlFile)
  const verifierPath = path.join(repositoryPath, migration.verifier)
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : ''
  const verifier = fs.existsSync(verifierPath) ? fs.readFileSync(verifierPath, 'utf8') : ''
  const sourceFilesPresent = fs.existsSync(sqlPath) && fs.existsSync(verifierPath)
  const casePresence = Object.fromEntries(Object.keys(migration.caseStates).map((caseName) => [caseName, verifier.includes(caseName)]))
  const sqlStatePresence = Object.fromEntries(Object.entries(migration.caseStates).map(([caseName, sqlState]) => [caseName, verifier.includes(`'${sqlState}'`)]))
  const raceNames = migration.raceCases ?? []
  const racePresence = raceNames.length === 0
    ? { status: 'not_applicable', reason: migration.noRaceReason }
    : { status: raceNames.every((raceCase) => verifier.includes(raceCase)) ? 'present' : 'missing', cases: Object.fromEntries(raceNames.map((raceCase) => [raceCase, verifier.includes(raceCase)])) }
  const tablePresence = Object.fromEntries(migration.tableMatchers.map((table) => [table, sql.includes(table) && verifier.includes(table)]))
  const schemaPresence = migration.sqlMatchers.map((matcher) => matcher.test(sql))
  const safetyPresence = Object.fromEntries(requiredSafetyFields.map((field) => [field, verifier.includes(field)]))
  const result = {
    migration: migration.migration,
    sqlFile: migration.sqlFile,
    verifier: migration.verifier,
    sourceFilesPresent,
    expectedCaseStates: migration.caseStates,
    casePresence,
    sqlStatePresence,
    raceCases: raceNames,
    racePresence,
    tablePresence,
    schemaPresence,
    safetyPresence,
    valid: sourceFilesPresent && Object.values(casePresence).every(Boolean) && Object.values(sqlStatePresence).every(Boolean) && (racePresence.status === 'present' || racePresence.status === 'not_applicable') && Object.values(tablePresence).every(Boolean) && schemaPresence.every(Boolean) && Object.values(safetyPresence).every(Boolean)
  }
  results.push(result)
  if (!result.valid) errors.push({ migration: migration.migration, result })
}

const result = {
  repositoryPath,
  migrations: results,
  expectedSqlStateLiterals,
  errors,
  authority: 'assertion_traceability_audit_only',
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  valid: errors.length === 0 && results.length === migrations.length
}
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ outputPath, ...result }, null, 2))
if (!result.valid) process.exitCode = 1
