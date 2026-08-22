import fs from 'node:fs'
import path from 'node:path'

const repositoryPath = process.env.PAYTRAY_REPOSITORY_PATH ?? process.argv[2] ?? process.cwd()
const outputPath = process.env.POSTGRES_ASSERTION_TRACEABILITY_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-postgres-assertion-traceability.json'

const migrations = [
  {
    migration: '006_ai_evaluation_foundation',
    sqlFile: 'packages/backend/migrations/006_ai_evaluation_foundation.sql',
    verifier: 'packages/backend/scripts/verify-migration-006-ai-evaluation-foundation.mjs',
    tableMatchers: ['ai_feature_snapshots', 'ai_evaluation_examples', 'ai_evaluation_runs', 'ai_shadow_decisions'],
    caseStates: {
      duplicateEvaluationExample: '23505',
      invalidConfidence: '23514',
      appliedWithoutHumanReview: '23514'
    },
    raceCase: 'concurrentDuplicateEvaluationExample',
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
    caseStates: {
      duplicateQueryCandidate: '23505',
      invalidRank: '23514',
      invalidScore: '23514'
    },
    raceCase: 'concurrentDuplicateQueryCandidate',
    sqlMatchers: [
      /CHECK \(rank_position > 0\)/i,
      /CHECK \(baseline_score >= 0 AND baseline_score <= 100\)/i,
      /UNIQUE \(query_id, candidate_profile_id\)/i
    ]
  },
  {
    migration: '008_production_telemetry',
    sqlFile: 'packages/backend/migrations/008_production_telemetry.sql',
    verifier: 'packages/backend/scripts/verify-migration-008-production-telemetry.mjs',
    tableMatchers: ['production_telemetry_events'],
    caseStates: {
      duplicateEventId: '23505',
      invalidEventType: '23514',
      invalidPrivacyClass: '23514'
    },
    raceCase: 'concurrentDuplicateEventId',
    sqlMatchers: [
      /CHECK \(event_type IN \(/i,
      /CHECK \(privacy_class IN \(/i,
      /UNIQUE \(event_id\)/i
    ]
  },
  {
    migration: '009_verified_outcome_provenance',
    sqlFile: 'packages/backend/migrations/009_verified_outcome_provenance.sql',
    verifier: 'packages/backend/scripts/verify-migration-009-verified-outcome-provenance.mjs',
    tableMatchers: ['engagement_outcome_events', 'engagement_outcome_events_verified_index'],
    caseStates: {
      invalidStatus: '23514',
      oversizedHash: '22001'
    },
    raceCase: null,
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
const requiredSafetyFields = [
  'releaseEligible: false',
  'settlementAuthority: false',
  "mutation: 'read_only'",
  'deploymentPerformed: false',
  'settlementMutationPerformed: false'
]
const expectedSqlStateLiterals = [...new Set(migrations.flatMap((migration) => Object.values(migration.caseStates)))]

for (const migration of migrations) {
  const sqlPath = path.join(repositoryPath, migration.sqlFile)
  const verifierPath = path.join(repositoryPath, migration.verifier)
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : ''
  const verifier = fs.existsSync(verifierPath) ? fs.readFileSync(verifierPath, 'utf8') : ''
  const sourceFilesPresent = fs.existsSync(sqlPath) && fs.existsSync(verifierPath)
  const casePresence = Object.fromEntries(Object.keys(migration.caseStates).map((caseName) => [caseName, verifier.includes(caseName)]))
  const sqlStatePresence = Object.fromEntries(Object.entries(migration.caseStates).map(([caseName, sqlState]) => [caseName, verifier.includes(`'${sqlState}'`)]))
  const racePresence = migration.raceCase === null
    ? { status: 'not_applicable', reason: migration.noRaceReason }
    : { status: verifier.includes(migration.raceCase) ? 'present' : 'missing', case: migration.raceCase }
  const tablePresence = Object.fromEntries(migration.tableMatchers.map((table) => [table, sql.includes(table) && verifier.includes(table)]))
  const schemaPresence = migration.sqlMatchers.map((matcher) => matcher.test(sql))
  const safetyPresence = Object.fromEntries(requiredSafetyFields.map((field) => [field, verifier.includes(field)]))
  const raceValid = migration.raceCase === null || racePresence.status === 'present'
  const result = {
    migration: migration.migration,
    sqlFile: migration.sqlFile,
    verifier: migration.verifier,
    sourceFilesPresent,
    expectedCaseStates: migration.caseStates,
    casePresence,
    sqlStatePresence,
    raceCase: migration.raceCase,
    racePresence,
    tablePresence,
    schemaPresence,
    safetyPresence,
    valid: sourceFilesPresent &&
      Object.values(casePresence).every(Boolean) &&
      Object.values(sqlStatePresence).every(Boolean) &&
      raceValid &&
      Object.values(tablePresence).every(Boolean) &&
      schemaPresence.every(Boolean) &&
      Object.values(safetyPresence).every(Boolean)
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
