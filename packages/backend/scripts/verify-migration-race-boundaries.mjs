import fs from 'node:fs'
import path from 'node:path'

const repositoryPath = process.env.PAYTRAY_REPOSITORY_PATH ?? process.argv[2] ?? process.cwd()
const outputPath = process.env.MIGRATION_RACE_BOUNDARY_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-migration-race-boundaries.json'

const contracts = [
  {
    migration: '006_ai_evaluation_foundation',
    sqlFile: 'packages/backend/migrations/006_ai_evaluation_foundation.sql',
    verifier: 'packages/backend/scripts/verify-migration-006-ai-evaluation-foundation.mjs',
    table: 'ai_evaluation_examples',
    raceCase: 'concurrentDuplicateEvaluationExample',
    requiredMarkers: [
      ['winner cardinality', /winners\.length/],
      ['loser cardinality', /losers\.length/],
      ['attempt bound', /attempts\s*-\s*1/],
      ['duplicate loser SQLSTATE', /['"]23505['"]/]
    ]
  },
  {
    migration: '007_discovery_impressions',
    sqlFile: 'packages/backend/migrations/007_discovery_impressions.sql',
    verifier: 'packages/backend/scripts/verify-migration-007-discovery-impressions.mjs',
    table: 'discovery_impressions',
    raceCase: 'concurrentDuplicateQueryCandidate',
    requiredMarkers: [
      ['winner cardinality', /winners\.length/],
      ['loser cardinality', /losers\.length/],
      ['attempt bound', /attempts\s*-\s*1/],
      ['duplicate loser SQLSTATE', /['"]23505['"]/]
    ]
  },
  {
    migration: '008_production_telemetry',
    sqlFile: 'packages/backend/migrations/008_production_telemetry.sql',
    verifier: 'packages/backend/scripts/verify-migration-008-production-telemetry.mjs',
    table: 'production_telemetry_events',
    raceCase: 'concurrentDuplicateEventId',
    requiredMarkers: [
      ['winner cardinality', /winners\.length/],
      ['loser cardinality', /losers\.length/],
      ['attempt bound', /attempts\s*-\s*1/],
      ['duplicate loser SQLSTATE', /['"]23505['"]/]
    ]
  },
  {
    migration: '009_verified_outcome_provenance',
    sqlFile: 'packages/backend/migrations/009_verified_outcome_provenance.sql',
    verifier: 'packages/backend/scripts/verify-migration-009-verified-outcome-provenance.mjs',
    table: 'engagement_outcome_events',
    raceCase: null,
    noRaceReason: 'not_applicable: migration-009 adds nullable provenance columns and an index; it defines no new unique, CHECK, or state-transition boundary for a concurrency race',
    requiredMarkers: []
  }
]

const safetyFields = [
  'releaseEligible: false',
  'settlementAuthority: false',
  "mutation: 'read_only'",
  'deploymentPerformed: false',
  'settlementMutationPerformed: false'
]
const results = []
const errors = []

for (const contract of contracts) {
  const sqlPath = path.join(repositoryPath, contract.sqlFile)
  const verifierPath = path.join(repositoryPath, contract.verifier)
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : ''
  const verifier = fs.existsSync(verifierPath) ? fs.readFileSync(verifierPath, 'utf8') : ''
  const sourceFilesPresent = Boolean(sql && verifier)
  const tablePresent = sourceFilesPresent && sql.includes(contract.table) && verifier.includes(contract.table)
  const raceCasePresent = contract.raceCase === null || verifier.includes(contract.raceCase)
  const markerPresence = Object.fromEntries(contract.requiredMarkers.map(([name, pattern]) => [name, pattern.test(verifier)]))
  const noRaceBoundary = contract.raceCase === null
    ? { status: 'not_applicable', reason: contract.noRaceReason, raceMarkersAbsent: !/Promise\.all|Race|raceRuns|concurrent/i.test(verifier) }
    : null
  const safetyPresence = Object.fromEntries(safetyFields.map((field) => [field, verifier.includes(field)]))
  const valid = sourceFilesPresent && tablePresent && raceCasePresent && Object.values(markerPresence).every(Boolean) && (noRaceBoundary === null || noRaceBoundary.raceMarkersAbsent) && Object.values(safetyPresence).every(Boolean)
  const result = {
    migration: contract.migration,
    sqlFile: contract.sqlFile,
    verifier: contract.verifier,
    sourceFilesPresent,
    tablePresent,
    raceCase: contract.raceCase,
    raceCasePresent,
    requiredMarkers: contract.requiredMarkers.map(([name]) => name),
    markerPresence,
    noRaceBoundary,
    safetyPresence,
    valid
  }
  results.push(result)
  if (!valid) errors.push({ migration: contract.migration, result })
}

const report = {
  repositoryPath,
  migrations: results,
  errors,
  authority: 'race_boundary_audit_only',
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  valid: errors.length === 0
}
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ outputPath, ...report }, null, 2))
if (!report.valid) process.exitCode = 1
