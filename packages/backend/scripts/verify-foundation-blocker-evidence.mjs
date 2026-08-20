import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i
const EXPECTED_MIGRATIONS = ['001_init', '002_financial_core', '003_discovery_v1', '004_engagement_context', '005_outcomes_and_metrics', '006_ai_evaluation_foundation', '007_discovery_impressions', '008_production_telemetry', '009_verified_outcome_provenance', '010_ledger_intent_idempotency', '011_payment_stream_verifier_provenance', '012_shadow_run_review', '013_verifier_cursors', '014_webhook_replay_claims', '015_verified_trust_signals', '016_webhook_inbox', '017_extension_hooks', '018_operations_quality_runs', '019_reviewer_attestations']

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${currentPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${currentPath}.${key}`)
    scanSensitiveKeys(child, `${currentPath}.${key}`)
  }
}

function requireCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail(`${label} must be a lowercase 40-character release commit`)
  return value.trim()
}

function assertSafeFields(report, label) {
  scanSensitiveKeys(report)
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.deploymentPerformed !== false || report.settlementMutationPerformed === true) fail(`${label} violates immutable authority fields`)
  if (report.mutation !== 'read_only') fail(`${label} mutation must be read_only`)
}

function loadEvidence(filePath, { label, target, commit }) {
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(filePath, { label, target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail(`${label} file is not valid JSON`)
  }
  scanSensitiveKeys(report)
  assertSafeFields(report, label)
  if (report.releaseCommit !== undefined && report.releaseCommit !== commit) fail(`${label} releaseCommit does not match the requested release commit`)
  return { report, filePath: resolvedPath, sha256 }
}

function verifyMigrations(evidence, commit) {
  const report = evidence.report
  const migrationNames = Array.isArray(report.migrationNames) ? report.migrationNames : []
  const migrationsMatch = report.status === 'ok' && report.databaseStatus === 'ready' && report.schemaContractsPassed === true && JSON.stringify(migrationNames) === JSON.stringify(EXPECTED_MIGRATIONS)
  return {
    blocker: 'migrations',
    status: migrationsMatch ? 'verified_reference' : 'blocked',
    reportKind: report.reportKind,
    releaseCommit: commit,
    sourceSha256: evidence.sha256,
    filePath: evidence.filePath,
    expectedMigrationCount: EXPECTED_MIGRATIONS.length,
    observedMigrationCount: migrationNames.length,
    migrationNames,
    schemaContractsPassed: report.schemaContractsPassed === true,
    targetDatabaseStatus: report.databaseStatus || null,
    nextAction: migrationsMatch ? 'rerun the release-gate matrix to convert the reference into a fresh gate result' : 'provide an authenticated ready target PostgreSQL report with all repository migrations and schema contracts passing'
  }
}

function verifyRailwayTrial(evidence, commit) {
  const report = evidence.report
  const settlement = report.preflight?.settlement || {}
  const comparison = report.settingsComparison || {}
  const metadata = report.railwayMetadata || {}
  const railwayMatch = report.status === 'match' && report.preflight?.ready === true && comparison.status === 'match' && report.trialUrl?.configured === true && metadata.status === 'observed' && Number(settlement.chainId) === 84532 && settlement.mainnetEnabled === false
  return {
    blocker: 'railway-trial',
    status: railwayMatch ? 'verified_reference' : 'blocked',
    reportKind: report.reportKind,
    releaseCommit: commit,
    sourceSha256: evidence.sha256,
    filePath: evidence.filePath,
    comparisonStatus: comparison.status || null,
    metadataStatus: metadata.status || null,
    trialUrlConfigured: report.trialUrl?.configured === true,
    chainId: Number(settlement.chainId) || null,
    mainnetEnabled: settlement.mainnetEnabled === true,
    nextAction: railwayMatch ? 'rerun target operations and the release-gate matrix to verify dependent checks' : 'capture authenticated redacted Railway settings with HTTPS origin, observed metadata, Base Sepolia chain ID 84532, and mainnet disabled; do not infer settings from a project URL'
  }
}

export function buildFoundationBlockerEvidence({ migrationEvidenceFile, railwayEvidenceFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported foundation evidence target: ${target}`)
  const commit = requireCommit(releaseCommit, 'releaseCommit')
  const migration = loadEvidence(migrationEvidenceFile, { label: 'migration evidence', target, commit })
  const railway = loadEvidence(railwayEvidenceFile, { label: 'Railway evidence', target, commit })
  if (migration.report.reportKind !== 'migration_evidence') fail('migration evidence reportKind must be migration_evidence')
  if (railway.report.reportKind !== 'railway_trial_evidence') fail('Railway evidence reportKind must be railway_trial_evidence')
  const migrationResult = verifyMigrations(migration, commit)
  const railwayResult = verifyRailwayTrial(railway, commit)
  const verifiedCount = [migrationResult, railwayResult].filter((item) => item.status === 'verified_reference').length
  return {
    reportKind: 'foundation_blocker_evidence',
    status: verifiedCount === 2 ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    evidenceCount: 2,
    verifiedReferenceCount: verifiedCount,
    blockers: [migrationResult, railwayResult],
    nextAction: verifiedCount === 2 ? 'rerun the release-gate matrix and ingest the fresh redacted release-gate report' : 'capture and independently verify the missing foundation evidence; this report cannot clear a release gate',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'foundation_blocker_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildFoundationBlockerEvidence({
      migrationEvidenceFile: process.env.MIGRATION_EVIDENCE_FILE,
      railwayEvidenceFile: process.env.RAILWAY_EVIDENCE_FILE,
      target: process.env.FOUNDATION_EVIDENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.FOUNDATION_EVIDENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'foundation_blocker_evidence',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'foundation_blocker_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
