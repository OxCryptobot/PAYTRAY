import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateOperationsQualityArtifact } from './verify-operations-quality-artifact.mjs'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes)/i
const RECOVERY_STATUSES = new Set(['verified', 'schema_catalog_only'])
const RESTORE_STATUSES = new Set(['verified', 'not_requested'])
const EXPECTED_MIGRATIONS = [
  '001_init',
  '002_financial_core',
  '003_discovery_v1',
  '004_engagement_context',
  '005_outcomes_and_metrics',
  '006_ai_evaluation_foundation',
  '007_discovery_impressions',
  '008_production_telemetry',
  '009_verified_outcome_provenance',
  '010_ledger_intent_idempotency',
  '011_payment_stream_verifier_provenance',
  '012_shadow_run_review',
  '013_verifier_cursors',
  '014_webhook_replay_claims',
  '015_verified_trust_signals',
  '016_webhook_inbox',
  '017_extension_hooks',
  '018_operations_quality_runs',
  '019_reviewer_attestations',
  '020_outbox_lease_state'
]
const DEFAULT_ARTIFACTS = [
  'artifacts/recovery-evidence.json',
  'artifacts/restored-migrations.json',
  'artifacts/restored-ready-postgres.json',
  'artifacts/restored-operations-quality.json',
  'artifacts/restored-operations-quality-verification.json',
  'artifacts/restored-migration-018-constraints.json',
  'artifacts/restored-migration-018-concurrency.json',
  'artifacts/restored-migration-017-extension-hooks.json',
  'artifacts/restored-migration-016-webhook-inbox.json',
  'artifacts/restored-migration-015-trust-signals.json',
  'artifacts/restored-migration-014-webhook-replay-claims.json',
  'artifacts/restored-migration-013-verifier-cursors.json',
  'artifacts/restored-migration-009-verified-outcome-provenance.json',
  'artifacts/restored-migration-010-ledger-intent-idempotency.json',
  'artifacts/restored-migration-011-payment-provenance.json',
  'artifacts/restored-migration-012-shadow-run-review.json',
  'artifacts/restored-migration-019-constraints.json',
  'artifacts/restored-migration-020-outbox-leases.json',
  'artifacts/restored-attestation-concurrency.json'
]

function fail(message) {
  throw new Error(message)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertNoSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${currentPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed in recovery artifact: ${currentPath}.${key}`)
    assertNoSensitiveKeys(child, `${currentPath}.${key}`)
  }
}

function loadJson(artifactPath) {
  let raw
  try {
    raw = fs.readFileSync(artifactPath, 'utf8')
  } catch (error) {
    fail(`recovery artifact cannot be read: ${artifactPath}: ${error.message}`)
  }
  try {
    const value = JSON.parse(raw)
    assertObject(value, artifactPath)
    assertNoSensitiveKeys(value)
    return value
  } catch (error) {
    if (error instanceof SyntaxError) fail(`recovery artifact is not valid JSON: ${artifactPath}`)
    throw error
  }
}

function assertSafety(value, label, { requireReleaseEligible = true } = {}) {
  if (requireReleaseEligible && value.releaseEligible !== false) fail(`${label}.releaseEligible must remain false`)
  if (value.settlementAuthority !== false) fail(`${label}.settlementAuthority must remain false`)
  if (value.deploymentPerformed !== false) fail(`${label}.deploymentPerformed must remain false`)
  if (value.settlementMutationPerformed !== false) fail(`${label}.settlementMutationPerformed must remain false`)
  if (value.mutation !== 'read_only' && value.mutation !== 'isolated_recovery_only' && value.mutation !== 'backup_only') {
    fail(`${label}.mutation is not an allowed non-mutating value`)
  }
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/i.test(String(value || ''))) fail(`${label} must be a SHA-256 hex digest`)
}

function assertLocalDisposableDatabaseUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a database URL`)
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label} is not a valid database URL`)
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  const disposableName = /(ci|test|testing|disposable|recovery|restore|attestation)/.test(databaseName)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !localHost || !disposableName) {
    fail(`${label} must be a local test/disposable/recovery PostgreSQL URL`)
  }
  if (url.username || url.password) fail(`${label} must not contain credentials`)
  return `${url.protocol}//${url.hostname}${url.pathname}`
}

const RESOURCE_FIELDS = [
  'rssBytes',
  'rssDeltaBytes',
  'heapUsedBytes',
  'externalBytes',
  'arrayBuffersBytes',
  'peakRssKb',
  'userCpuTimeUs',
  'systemCpuTimeUs',
  'fsReadOps',
  'fsWriteOps',
  'voluntaryContextSwitches',
  'involuntaryContextSwitches'
]

function validateResourceSample(sample, label) {
  assertObject(sample, label)
  if (sample.basis !== 'node_process_resource_usage') fail(`${label}.basis is invalid`)
  for (const field of RESOURCE_FIELDS) {
    if (!Number.isSafeInteger(sample[field]) || sample[field] < 0) fail(`${label}.${field} must be a nonnegative integer`)
  }
  return { basis: sample.basis, fieldCount: RESOURCE_FIELDS.length }
}

function validateChildProcessTelemetry(childProcesses, label) {
  if (childProcesses === undefined) return null
  assertObject(childProcesses, label)
  const reports = Object.fromEntries(Object.entries(childProcesses).map(([name, report]) => {
    assertObject(report, `${label}.${name}`)
    if (report.basis !== 'procfs_child_process') fail(`${label}.${name}.basis is invalid`)
    if (!Number.isSafeInteger(report.clockTickHz) || report.clockTickHz < 1) fail(`${label}.${name}.clockTickHz must be a positive integer`)
    for (const field of ['elapsedMs', 'userCpuTimeMs', 'systemCpuTimeMs']) {
      if (typeof report[field] !== 'number' || !Number.isFinite(report[field]) || report[field] < 0) fail(`${label}.${name}.${field} must be a nonnegative number`)
    }
    if (!Number.isSafeInteger(report.peakRssKb) || report.peakRssKb < 0) fail(`${label}.${name}.peakRssKb must be a nonnegative integer`)
    if (report.exitCode !== 0 || report.signal !== null) fail(`${label}.${name} must have a successful process exit`)
    return [name, { basis: report.basis, elapsedMs: report.elapsedMs, peakRssKb: report.peakRssKb }]
  }))
  return reports
}

function validateNullableNonnegativeNumber(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail(`${label} must be null or a nonnegative number`)
}

function validateDatabaseStats(stats, label) {
  if (stats === null) return null
  assertObject(stats, label)
  for (const field of ['databaseSizeBytes', 'tempBytes', 'tempFiles', 'blocksRead', 'blocksHit']) {
    if (!Number.isSafeInteger(stats[field]) || stats[field] < 0) fail(`${label}.${field} must be a nonnegative integer`)
  }
  return true
}

function validateDatabaseTelemetry(database, label) {
  if (database === undefined) return null
  assertObject(database, label)
  if (database.basis !== 'postgresql_observability') fail(`${label}.basis is invalid`)
  for (const field of ['sampleCount']) {
    if (!Number.isSafeInteger(database[field]) || database[field] < 2) fail(`${label}.${field} must be an integer >= 2`)
  }
  assertObject(database.connectionAcquisitionMs, `${label}.connectionAcquisitionMs`)
  for (const field of ['count']) {
    if (!Number.isSafeInteger(database.connectionAcquisitionMs[field]) || database.connectionAcquisitionMs[field] < 0) fail(`${label}.connectionAcquisitionMs.${field} must be a nonnegative integer`)
  }
  for (const field of ['p50', 'p95', 'p99', 'max', 'mean']) validateNullableNonnegativeNumber(database.connectionAcquisitionMs[field], `${label}.connectionAcquisitionMs.${field}`)
  assertObject(database.waitEvents, `${label}.waitEvents`)
  if (!Number.isSafeInteger(database.waitEvents.sampleCount) || database.waitEvents.sampleCount < 2) fail(`${label}.waitEvents.sampleCount must be an integer >= 2`)
  if (!Array.isArray(database.waitEvents.observations) || database.waitEvents.observations.length > 32) fail(`${label}.waitEvents.observations must contain at most 32 rows`)
  database.waitEvents.observations.forEach((event, index) => {
    assertObject(event, `${label}.waitEvents.observations[${index}]`)
    for (const field of ['waitEventType', 'waitEvent', 'state']) {
      if (typeof event[field] !== 'string' || event[field].length > 80) fail(`${label}.waitEvents.observations[${index}].${field} is invalid`)
    }
    for (const field of ['observations', 'observedBackendCount']) {
      if (!Number.isSafeInteger(event[field]) || event[field] < 0) fail(`${label}.waitEvents.observations[${index}].${field} must be a nonnegative integer`)
    }
  })
  assertObject(database.databaseStats, `${label}.databaseStats`)
  validateDatabaseStats(database.databaseStats.before, `${label}.databaseStats.before`)
  validateDatabaseStats(database.databaseStats.after, `${label}.databaseStats.after`)
  validateDatabaseStats(database.databaseStats.deltas, `${label}.databaseStats.deltas`)
  assertObject(database.temporaryStorage, `${label}.temporaryStorage`)
  for (const field of ['tempBytesDelta', 'tempFilesDelta']) {
    if (!Number.isSafeInteger(database.temporaryStorage[field]) || database.temporaryStorage[field] < 0) fail(`${label}.temporaryStorage.${field} must be a nonnegative integer`)
  }
  for (const field of ['throughputBytesPerSecond', 'operationElapsedMs']) validateNullableNonnegativeNumber(database.temporaryStorage[field], `${label}.temporaryStorage.${field}`)
  if (!Array.isArray(database.errors) || database.errors.some((error) => typeof error !== 'string' || error.length > 200)) fail(`${label}.errors must contain bounded strings`)
  return { basis: database.basis, sampleCount: database.sampleCount, waitEventCount: database.waitEvents.observations.length }
}

function validateStorageTelemetry(storage, label) {
  if (storage === undefined) return null
  assertObject(storage, label)
  if (storage.basis !== 'local_disposable_backup_file') fail(`${label}.basis is invalid`)
  if (!Number.isSafeInteger(storage.backupBytes) || storage.backupBytes < 0) fail(`${label}.backupBytes must be a nonnegative integer`)
  validateNullableNonnegativeNumber(storage.backupDurationMs, `${label}.backupDurationMs`)
  if (typeof storage.backupWriteThroughputBytesPerSecond !== 'number' || !Number.isFinite(storage.backupWriteThroughputBytesPerSecond) || storage.backupWriteThroughputBytesPerSecond < 0) fail(`${label}.backupWriteThroughputBytesPerSecond must be a nonnegative number`)
  return { basis: storage.basis, backupBytes: storage.backupBytes }
}

function validateResourceTelemetry(resource, label) {
  if (resource === undefined) return null
  assertObject(resource, label)
  const process = validateResourceSample(resource.process, `${label}.process`)
  assertObject(resource.phases, `${label}.phases`)
  const phases = Object.fromEntries(Object.entries(resource.phases).map(([phaseName, phase]) => [phaseName, validateResourceSample(phase, `${label}.phases.${phaseName}`)]))
  return { basis: resource.basis, process, phases }
}

function validateTiming(timing, label) {
  if (timing === undefined) return null
  assertObject(timing, label)
  if (typeof timing.startedAt !== 'string' || Number.isNaN(Date.parse(timing.startedAt))) fail(`${label}.startedAt must be an ISO timestamp`)
  if (typeof timing.completedAt !== 'string' || Number.isNaN(Date.parse(timing.completedAt))) fail(`${label}.completedAt must be an ISO timestamp`)
  if (!Number.isSafeInteger(timing.elapsedMs) || timing.elapsedMs < 0) fail(`${label}.elapsedMs must be a nonnegative integer`)
  assertObject(timing.phases, `${label}.phases`)
  for (const [phaseName, phase] of Object.entries(timing.phases)) {
    assertObject(phase, `${label}.phases.${phaseName}`)
    if (!['ok', 'blocked'].includes(phase.status)) fail(`${label}.phases.${phaseName}.status is invalid`)
    if (!Number.isSafeInteger(phase.durationMs) || phase.durationMs < 0) fail(`${label}.phases.${phaseName}.durationMs must be a nonnegative integer`)
  }
  assertObject(timing.rto, `${label}.rto`)
  const targetConfigured = timing.rto.targetMs !== null
  if (targetConfigured && (!Number.isSafeInteger(timing.rto.targetMs) || timing.rto.targetMs <= 0)) fail(`${label}.rto.targetMs must be null or a positive integer`)
  if (timing.rto.targetConfigured !== targetConfigured) fail(`${label}.rto.targetConfigured is inconsistent`)
  if (timing.rto.withinTarget !== null && typeof timing.rto.withinTarget !== 'boolean') fail(`${label}.rto.withinTarget must be null or boolean`)
  if (targetConfigured && timing.rto.withinTarget !== timing.elapsedMs <= timing.rto.targetMs) fail(`${label}.rto.withinTarget is inconsistent with elapsedMs`)
  if (!targetConfigured && timing.rto.withinTarget !== null) fail(`${label}.rto.withinTarget must be null when targetMs is null`)
  if (!['not_configured', 'operator_supplied'].includes(timing.rto.basis)) fail(`${label}.rto.basis is invalid`)
  const resource = validateResourceTelemetry(timing.resource, `${label}.resource`)
  const database = validateDatabaseTelemetry(timing.database, `${label}.database`)
  const storage = validateStorageTelemetry(timing.storage, `${label}.storage`)
  const childProcesses = validateChildProcessTelemetry(timing.childProcesses, `${label}.childProcesses`)
  return {
    elapsedMs: timing.elapsedMs,
    phaseCount: Object.keys(timing.phases).length,
    targetConfigured,
    withinTarget: timing.rto.withinTarget,
    ...(resource ? { resource } : {}),
    ...(database ? { database } : {}),
    ...(storage ? { storage } : {}),
    ...(childProcesses ? { childProcesses } : {})
  }
}

function validateRecoveryEvidence(artifact) {
  assertObject(artifact, 'recovery-evidence')
  if (!RECOVERY_STATUSES.has(artifact.status)) fail('recovery-evidence.status is invalid')
  if (artifact.authority !== 'recovery_evidence_only') fail('recovery-evidence.authority is invalid')
  assertSafety(artifact, 'recovery-evidence')
  if (!['isolated_recovery_only', 'backup_only'].includes(artifact.mutation)) fail('recovery-evidence.mutation is invalid')
  const sourceDatabase = assertLocalDisposableDatabaseUrl(artifact.sourceDatabase, 'recovery-evidence.sourceDatabase')

  assertObject(artifact.backup, 'recovery-evidence.backup')
  if (typeof artifact.backup.path !== 'string' || artifact.backup.path.length === 0) fail('recovery-evidence.backup.path is required')
  if (!Number.isSafeInteger(artifact.backup.bytes) || artifact.backup.bytes < 0) fail('recovery-evidence.backup.bytes is invalid')
  assertSha256(artifact.backup.sha256, 'recovery-evidence.backup.sha256')
  if (!Number.isSafeInteger(artifact.backup.catalogEntries) || artifact.backup.catalogEntries < 0) fail('recovery-evidence.backup.catalogEntries is invalid')
  if (artifact.backup.format !== 'custom') fail('recovery-evidence.backup.format must be custom')
  if (artifact.backup.ownerAndPrivilegesExcluded !== true) fail('recovery-evidence.backup.ownerAndPrivilegesExcluded must be true')

  assertObject(artifact.restore, 'recovery-evidence.restore')
  if (!RESTORE_STATUSES.has(artifact.restore.status)) fail('recovery-evidence.restore.status is invalid')
  if (artifact.restore.status === 'verified') {
    if (!Number.isSafeInteger(artifact.restore.tableCount) || artifact.restore.tableCount < 1) fail('recovery-evidence.restore.tableCount is invalid')
    if (artifact.restore.migrationCount !== 20) fail('recovery-evidence.restore.migrationCount must be 20')
    const restoreDatabase = assertLocalDisposableDatabaseUrl(artifact.restore.database, 'recovery-evidence.restore.database')
    return { status: artifact.status, authority: artifact.authority, sourceDatabase, restoreDatabase, migrationCount: 20, timing: validateTiming(artifact.timing, 'recovery-evidence.timing') }
  }
  if (artifact.restore.database !== undefined) assertLocalDisposableDatabaseUrl(artifact.restore.database, 'recovery-evidence.restore.database')
  return { status: artifact.status, authority: artifact.authority, sourceDatabase, restoreDatabase: null, migrationCount: null, timing: validateTiming(artifact.timing, 'recovery-evidence.timing') }
}

function validateRestoredMigrations(artifact) {
  assertObject(artifact, 'restored-migrations')
  if (!['ok', 'verified'].includes(artifact.status)) fail('restored-migrations.status is invalid')
  if (artifact.databaseStatus !== undefined && artifact.databaseStatus !== 'ready') fail('restored-migrations.databaseStatus must be ready')
  if (!Array.isArray(artifact.migrationNames) || artifact.migrationNames.length !== 20) fail('restored-migrations must contain exactly 20 migrations')
  if (artifact.migrationNames.some((name, index) => name !== EXPECTED_MIGRATIONS[index])) fail('restored-migrations migration order does not match 001 through 020')
  return { status: artifact.status, migrationCount: artifact.migrationNames.length }
}

function validateReadyPostgres(artifact) {
  assertObject(artifact, 'restored-ready-postgres')
  if (artifact.status !== 'verified') fail('restored-ready-postgres.status must be verified')
  if (artifact.databaseStatus !== 'ready') fail('restored-ready-postgres.databaseStatus must be ready')
  assertObject(artifact.checks, 'restored-ready-postgres.checks')
  if (Object.values(artifact.checks).some((value) => value !== true)) fail('restored-ready-postgres has a failed route contract')
  assertObject(artifact.routeStatuses, 'restored-ready-postgres.routeStatuses')
  assertSafety(artifact, 'restored-ready-postgres')
  return { status: artifact.status, checkCount: Object.keys(artifact.checks).length, routeCount: Object.keys(artifact.routeStatuses).length }
}

function validateOperationsQuality(artifactPath) {
  const result = validateOperationsQualityArtifact({ artifactPath, requireAudit: true })
  return { status: result.status, reportStatus: result.reportStatus, checkCount: result.checkCount, auditStatus: result.audit.status }
}

function validateOperationsQualityVerification(artifact) {
  assertObject(artifact, 'restored-operations-quality-verification')
  if (artifact.status !== 'verified') fail('restored-operations-quality-verification.status must be verified')
  if (artifact.authority !== 'operations_quality_artifact_verification_only') fail('restored-operations-quality-verification.authority is invalid')
  assertSafety(artifact, 'restored-operations-quality-verification')
  if (artifact.audit?.status !== 'recorded' && artifact.audit?.status !== 'replayed') fail('restored-operations-quality-verification.audit.status is invalid')
  return { status: artifact.status, reportStatus: artifact.reportStatus, auditStatus: artifact.audit.status }
}

function validateContract(artifact, label, expectedMigration = null) {
  assertObject(artifact, label)
  if (artifact.status !== 'verified') fail(`${label}.status must be verified`)
  if (expectedMigration && artifact.migration !== expectedMigration) fail(`${label}.migration must be ${expectedMigration}`)
  if (artifact.databaseIsolation !== true) fail(`${label}.databaseIsolation must be true`)
  assertSafety(artifact, label)
  return { status: artifact.status, migration: artifact.migration || null, databaseIsolation: true, cleanupPerformed: artifact.cleanupPerformed ?? artifact.cleanupRuns ?? artifact.cleanupCommits ?? null }
}

function classifyArtifact(artifactPath, artifact) {
  const name = path.basename(artifactPath)
  if (name === 'recovery-evidence.json') return validateRecoveryEvidence(artifact)
  if (name === 'restored-migrations.json') return validateRestoredMigrations(artifact)
  if (name === 'restored-ready-postgres.json') return validateReadyPostgres(artifact)
  if (name === 'restored-operations-quality.json') return validateOperationsQuality(artifactPath)
  if (name === 'restored-operations-quality-verification.json') return validateOperationsQualityVerification(artifact)
  if (name === 'restored-migration-018-constraints.json') return validateContract(artifact, name, '018_operations_quality_runs')
  if (name === 'restored-migration-018-concurrency.json') return validateContract(artifact, name, '018_operations_quality_runs')
  if (name === 'restored-migration-017-extension-hooks.json') return validateContract(artifact, name, '017_extension_hooks')
  if (name === 'restored-migration-016-webhook-inbox.json') return validateContract(artifact, name, '016_webhook_inbox')
  if (name === 'restored-migration-015-trust-signals.json') return validateContract(artifact, name, '015_verified_trust_signals')
  if (name === 'restored-migration-014-webhook-replay-claims.json') return validateContract(artifact, name, '014_webhook_replay_claims')
  if (name === 'restored-migration-013-verifier-cursors.json') return validateContract(artifact, name, '013_verifier_cursors')
  if (name === 'restored-migration-009-verified-outcome-provenance.json') return validateContract(artifact, name, '009_verified_outcome_provenance')
  if (name === 'restored-migration-010-ledger-intent-idempotency.json') return validateContract(artifact, name, '010_ledger_intent_idempotency')
  if (name === 'restored-migration-011-payment-provenance.json') return validateContract(artifact, name, '011_payment_stream_verifier_provenance')
  if (name === 'restored-migration-012-shadow-run-review.json') return validateContract(artifact, name, '012_shadow_run_review')
  if (name === 'restored-migration-019-constraints.json') return validateContract(artifact, name, '019_reviewer_attestations')
  if (name === 'restored-migration-020-outbox-leases.json') return validateContract(artifact, name, '020_outbox_lease_state')
  if (name === 'restored-attestation-concurrency.json') return validateContract(artifact, name)
  fail(`unsupported recovery artifact filename: ${name}`)
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await fs.promises.readFile(filePath))
  return hash.digest('hex')
}

async function validateSidecar(artifactPaths, sidecarPath) {
  let raw
  try {
    raw = await fs.promises.readFile(sidecarPath, 'utf8')
  } catch (error) {
    fail(`recovery SHA-256 sidecar cannot be read: ${error.message}`)
  }
  const entries = new Map()
  for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})\s+(\*?)(.+)$/i)
    if (!match) fail(`invalid recovery SHA-256 sidecar line: ${line}`)
    const listedPath = path.resolve(process.cwd(), match[3].replace(/^\*?/, ''))
    if (entries.has(listedPath)) fail(`duplicate recovery SHA-256 sidecar entry: ${match[3]}`)
    entries.set(listedPath, match[1].toLowerCase())
  }
  const verified = []
  for (const artifactPath of artifactPaths) {
    const absolutePath = path.resolve(artifactPath)
    const expected = entries.get(absolutePath)
    if (!expected) fail(`recovery SHA-256 sidecar is missing ${artifactPath}`)
    const actual = await sha256File(absolutePath)
    if (actual !== expected) fail(`recovery SHA-256 sidecar mismatch for ${artifactPath}`)
    verified.push({ artifact: artifactPath, sha256: actual })
  }
  return { status: 'verified', path: sidecarPath, files: verified }
}

export async function validateRecoveryArtifactBundle({ artifactPaths = DEFAULT_ARTIFACTS, sidecarPath = null } = {}) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) fail('artifactPaths must contain at least one file')
  const normalizedPaths = artifactPaths.map((artifactPath) => path.resolve(String(artifactPath)))
  const reports = {}
  for (const artifactPath of normalizedPaths) {
    const value = loadJson(artifactPath)
    reports[path.basename(artifactPath)] = classifyArtifact(artifactPath, value)
  }
  const sidecar = sidecarPath ? await validateSidecar(normalizedPaths, path.resolve(sidecarPath)) : { status: 'not_checked', reason: 'no sidecar path supplied' }
  return {
    status: 'verified',
    artifactCount: normalizedPaths.length,
    artifacts: reports,
    sidecar,
    authority: 'recovery_artifact_verification_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

function cliArtifactPaths() {
  const args = process.argv.slice(2)
  const sidecarIndex = args.indexOf('--sidecar')
  const sidecarPath = sidecarIndex >= 0 ? args[sidecarIndex + 1] : process.env.RECOVERY_ARTIFACT_SHA256_SIDECAR || null
  const artifactPaths = args.filter((value, index) => value !== '--sidecar' && index !== sidecarIndex + 1)
  return { artifactPaths: artifactPaths.length > 0 ? artifactPaths : DEFAULT_ARTIFACTS, sidecarPath }
}

try {
  if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    if (process.env.RECOVERY_ARTIFACT_ISOLATED !== 'true') fail('RECOVERY_ARTIFACT_ISOLATED=true is required')
    const { artifactPaths, sidecarPath } = cliArtifactPaths()
    console.log(JSON.stringify(await validateRecoveryArtifactBundle({ artifactPaths, sidecarPath }), null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'recovery_artifact_verification_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
