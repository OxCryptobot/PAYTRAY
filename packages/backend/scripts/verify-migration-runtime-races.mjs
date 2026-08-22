import fs from 'node:fs'
import path from 'node:path'

const repositoryPath = process.env.PAYTRAY_REPOSITORY_PATH ?? process.argv[2] ?? process.cwd()
const outputPath = process.env.MIGRATION_RUNTIME_RACE_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-migration-runtime-races.json'

const contracts = [
  {
    migration: '006_ai_evaluation_foundation',
    verifier: 'packages/backend/scripts/verify-migration-006-ai-evaluation-foundation.mjs',
    helper: 'exampleRace',
    reportCase: 'concurrentDuplicateEvaluationExample',
    insertHelper: 'insertEvaluationExample',
    requiredPatterns: [
      ['parallel attempts', /Promise\.all\(Array\.from\(\{ length: attempts \}/],
      ['transaction wrapper', /withTransaction\(pool, \(client\) => insertEvaluationExample/],
      ['committed outcome', /status: 'committed'/],
      ['rejected outcome', /status: 'rejected'/],
      ['one winner', /winners\.length, 1/],
      ['attempts-minus-one losers', /losers\.length, attempts - 1/],
      ['SQLSTATE 23505 losers', /losers\.every\(.*sqlState === '23505'/s],
      ['repetition report', /concurrentDuplicateEvaluationExample: \{ status: 'verified', attempts, repetitions, totalAttempts/],
      ['finally cleanup', /finally \{[\s\S]*DELETE FROM ai_shadow_decisions/]
    ]
  },
  {
    migration: '007_discovery_impressions',
    verifier: 'packages/backend/scripts/verify-migration-007-discovery-impressions.mjs',
    helper: 'impressionRace',
    reportCase: 'concurrentDuplicateQueryCandidate',
    insertHelper: 'insertImpression',
    requiredPatterns: [
      ['parallel attempts', /Promise\.all\(Array\.from\(\{ length: attempts \}/],
      ['transaction wrapper', /withTransaction\(pool, \(client\) => insertImpression/],
      ['committed outcome', /status: 'committed'/],
      ['rejected outcome', /status: 'rejected'/],
      ['one winner', /winners\.length, 1/],
      ['attempts-minus-one losers', /losers\.length, attempts - 1/],
      ['SQLSTATE 23505 losers', /losers\.every\(.*sqlState === '23505'/s],
      ['repetition report', /concurrentDuplicateQueryCandidate: \{ status: 'verified', attempts, repetitions, totalAttempts/],
      ['finally cleanup', /finally \{[\s\S]*DELETE FROM discovery_impressions/]
    ]
  },
  {
    migration: '008_production_telemetry',
    verifier: 'packages/backend/scripts/verify-migration-008-production-telemetry.mjs',
    helper: 'eventRace',
    reportCase: 'concurrentDuplicateEventId',
    insertHelper: 'insertEvent',
    requiredPatterns: [
      ['parallel attempts', /Promise\.all\(Array\.from\(\{ length: attempts \}/],
      ['transaction wrapper', /withTransaction\(pool, \(client\) => insertEvent/],
      ['committed outcome', /status: 'committed'/],
      ['rejected outcome', /status: 'rejected'/],
      ['one winner', /winners\.length, 1/],
      ['attempts-minus-one losers', /losers\.length, attempts - 1/],
      ['SQLSTATE 23505 losers', /losers\.every\(.*sqlState === '23505'/s],
      ['repetition report', /concurrentDuplicateEventId: \{ status: 'verified', attempts, repetitions, totalAttempts/],
      ['finally cleanup', /finally \{[\s\S]*DELETE FROM production_telemetry_events/]
    ]
  },
  {
    migration: '009_verified_outcome_provenance',
    verifier: 'packages/backend/scripts/verify-migration-009-verified-outcome-provenance.mjs',
    helper: null,
    reportCase: null,
    insertHelper: null,
    noRacePatterns: [
      ['no Promise.all', /Promise\.all/],
      ['no race helper', /(?:function|async function)\s+\w*Race/],
      ['no repetition race loop', /raceRuns|concurrentDuplicate/]
    ],
    requiredPatterns: [
      ['catalog verification', /verifyCatalog/],
      ['provenance round trip', /verification_evidence_hash/],
      ['SQLSTATE 23514', /'23514'/],
      ['SQLSTATE 22001', /'22001'/],
      ['finally cleanup', /finally \{[\s\S]*DELETE FROM engagement_outcome_events/]
    ]
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
  const verifierPath = path.join(repositoryPath, contract.verifier)
  const verifier = fs.existsSync(verifierPath) ? fs.readFileSync(verifierPath, 'utf8') : ''
  const sourcePresent = Boolean(verifier)
  const helperPresent = contract.helper === null || verifier.includes(`function ${contract.helper}`)
  const reportPresent = contract.reportCase === null || verifier.includes(contract.reportCase)
  const insertPresent = contract.insertHelper === null || verifier.includes(contract.insertHelper)
  const patternPresence = Object.fromEntries(contract.requiredPatterns.map(([name, pattern]) => [name, pattern.test(verifier)]))
  const noRacePatternPresence = contract.noRacePatterns
    ? Object.fromEntries(contract.noRacePatterns.map(([name, pattern]) => [name, !pattern.test(verifier)]))
    : null
  const safetyPresence = Object.fromEntries(safetyFields.map((field) => [field, verifier.includes(field)]))
  const valid = sourcePresent && helperPresent && reportPresent && insertPresent && Object.values(patternPresence).every(Boolean) && (noRacePatternPresence === null || Object.values(noRacePatternPresence).every(Boolean)) && Object.values(safetyPresence).every(Boolean)
  const result = {
    migration: contract.migration,
    verifier: contract.verifier,
    sourcePresent,
    helper: contract.helper,
    helperPresent,
    reportCase: contract.reportCase,
    reportPresent,
    insertHelper: contract.insertHelper,
    insertPresent,
    patternPresence,
    noRacePatternPresence,
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
  authority: 'runtime_race_traceability_audit_only',
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
