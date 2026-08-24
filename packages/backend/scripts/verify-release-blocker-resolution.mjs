import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SAFE_MUTATIONS = new Set([null, 'none', 'read_only'])
const TRACKING_STATUSES = new Set(['unassigned', 'operator_in_progress', 'evidence_submitted', 'rejected'])
const EVIDENCE_REFERENCE_KINDS = new Set(['release_evidence', 'release_approval', 'shadow_review_status', 'verifier_operations', 'verifier_cursor', 'reconciliation', 'recovery', 'verifier_reconciliation', 'durable_worker', 'verifier_durable_operations', 'railway_settings', 'outbox_health', 'idempotency_cleanup', 'target_operations',
 'operator_key_custody', 'secret_manager_custody', 'release_manifest', 'release_payload', 'cryptographic_sequence', 'authority_readiness', 'advisory_ai', 'token_metadata', 'downstream_operational'])
const DEPENDENCIES = Object.freeze({
  'quality-gate': [],
  'sdk-contract': [],
  'extension-contract': [],
  migrations: [],
  recovery: ['migrations'],
  'railway-trial': [],
  'verifier-operations': ['migrations', 'railway-trial'],
  'verifier-cursor-evidence': ['verifier-operations'],
  'outbox-health': ['migrations'],
  'idempotency-cleanup': ['migrations'],
  'target-operations': ['migrations', 'recovery', 'railway-trial', 'verifier-operations', 'outbox-health', 'idempotency-cleanup'],
  'reconciliation-evidence': ['verifier-operations', 'verifier-cursor-evidence'],
  'release-evidence': ['target-operations', 'verifier-cursor-evidence', 'reconciliation-evidence', 'outbox-health', 'idempotency-cleanup', 'advisory-ai'],
  'release-approval': ['release-evidence', 'reconciliation-evidence'],
  'operator-key-custody': ['release-evidence'],
  'secret-manager-custody': ['operator-key-custody'],
  'release-manifest': ['release-evidence'],
  'release-payload': ['release-approval', 'release-manifest', 'recovery', 'secret-manager-custody'],
  'release-authority-readiness': ['release-approval', 'release-evidence', 'release-payload', 'operator-key-custody', 'secret-manager-custody', 'verifier-cursor-evidence', 'reconciliation-evidence'],
  'advisory-ai': [],
  'token-metadata': ['migrations', 'railway-trial'],
  'smoke-phase2': ['migrations', 'token-metadata', 'verifier-operations', 'outbox-health', 'idempotency-cleanup']
})
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|token(?!s$|count$)|signature|raw.?content(?!persisted$|persistence$)|reviewer.?notes|transcript|recording|audio|video)/i

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

function assertSafeReport(report, label) {
  scanSensitiveKeys(report)
  if (report?.releaseEligible === true || report?.settlementAuthority === true || report?.deploymentPerformed === true || report?.settlementMutationPerformed === true) fail(`${label} contains an immutable authority violation`)
  if (!SAFE_MUTATIONS.has(report?.mutation ?? null)) fail(`${label} contains an unsafe mutation value`)
}

function requireCommit(value, field = 'releaseCommit') {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail(`${field} must be a lowercase 40-character release commit`)
  return value.trim()
}

function loadJson(filePath, label) {
  if (!filePath) fail(`${label} is required`)
  const resolvedPath = path.resolve(filePath)
  let stat
  try {
    stat = fs.lstatSync(resolvedPath)
  } catch (error) {
    fail(`${label} could not be inspected: ${error.message}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  return { value, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), filePath: resolvedPath }
}

function loadVerifiedEvidenceReference(reference, { name, commit }) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) fail(`tracking entry ${name} evidenceReference must be an object`)
  const kind = reference.kind
  if (!EVIDENCE_REFERENCE_KINDS.has(kind)) fail(`tracking entry ${name} evidenceReference kind is unsupported`)
  const target = reference.target
  if (!TARGETS.has(target)) fail(`tracking entry ${name} evidenceReference target is unsupported`)
  if (reference.verificationStatus !== 'independently_verified') fail(`tracking entry ${name} evidenceReference must be independently_verified`)
  const referenceCommit = requireCommit(reference.releaseCommit, `tracking entry ${name} evidenceReference releaseCommit`)
  if (referenceCommit !== commit) fail(`tracking entry ${name} evidenceReference releaseCommit does not match the release-gates commit`)
  if (typeof reference.reportKind !== 'string' || reference.reportKind.trim() === '') fail(`tracking entry ${name} evidenceReference reportKind is required`)
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(reference.path, { label: `tracking entry ${name} evidenceReference`, target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const sourceSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  if (sourceSha256 !== reference.sha256) fail(`tracking entry ${name} evidenceReference sha256 does not match file content`)
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`tracking entry ${name} evidenceReference file is not valid JSON`)
  }
  assertSafeReport(value, `tracking entry ${name} evidenceReference`)
  if (value.reportKind !== reference.reportKind) fail(`tracking entry ${name} evidenceReference reportKind does not match file content`)
  if (value.releaseCommit !== undefined && value.releaseCommit !== commit) fail(`tracking entry ${name} evidenceReference file releaseCommit does not match the release-gates commit`)
  return {
    kind,
    target,
    path: resolvedPath,
    sha256: sourceSha256,
    reportKind: reference.reportKind,
    releaseCommit: commit,
    verificationStatus: 'independently_verified'
  }
}

function normalizeTracking(tracking, commit) {
  if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)) fail('resolution tracking must be an object')
  scanSensitiveKeys(tracking)
  if (tracking.reportKind !== 'release_blocker_resolution_tracking') fail('tracking reportKind must be release_blocker_resolution_tracking')
  if (tracking.releaseEligible === true || tracking.settlementAuthority === true) fail('resolution tracking contains an immutable authority violation')
  if (!SAFE_MUTATIONS.has(tracking.mutation ?? null)) fail('resolution tracking contains an unsafe mutation value')
  if (tracking.releaseCommit !== undefined && requireCommit(tracking.releaseCommit, 'tracking releaseCommit') !== commit) fail('tracking releaseCommit does not match the release-gates commit')
  if (!Array.isArray(tracking.entries)) fail('resolution tracking entries must be an array')

  const seen = new Set()
  return tracking.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`tracking entry ${index} must be an object`)
    if (typeof entry.name !== 'string' || entry.name.trim() === '') fail(`tracking entry ${index} requires a name`)
    const name = entry.name.trim()
    if (seen.has(name)) fail(`duplicate tracking entry: ${name}`)
    seen.add(name)
    const status = entry.status || 'unassigned'
    if (!TRACKING_STATUSES.has(status)) fail(`tracking entry ${name} has unsupported status`)
    if (entry.evidenceArtifactSha256 !== undefined && (typeof entry.evidenceArtifactSha256 !== 'string' || !SHA256.test(entry.evidenceArtifactSha256))) fail(`tracking entry ${name} evidenceArtifactSha256 must be a 64-character lowercase SHA-256`)
    const evidenceReference = entry.evidenceReference ? loadVerifiedEvidenceReference(entry.evidenceReference, { name, commit }) : null
    if (evidenceReference && entry.evidenceArtifactSha256 && entry.evidenceArtifactSha256 !== evidenceReference.sha256) fail(`tracking entry ${name} evidenceArtifactSha256 does not match evidenceReference sha256`)
    return {
      name,
      status,
      evidenceArtifactSha256: evidenceReference?.sha256 || entry.evidenceArtifactSha256 || null,
      evidenceReference,
      lastCheckedAt: typeof entry.lastCheckedAt === 'string' && !Number.isNaN(Date.parse(entry.lastCheckedAt)) ? entry.lastCheckedAt : null
    }
  })
}

function normalizeCheck(check, trackingByName, gateStates) {
  if (!check || typeof check !== 'object' || typeof check.name !== 'string') fail('every release-gate check must have a name')
  if (!['passed', 'operator_blocked', 'failed'].includes(check.state)) fail(`release-gate check ${check.name} has invalid state`)
  if (check.releaseEligible === true || check.settlementAuthority === true || check.deploymentPerformed === true || check.settlementMutationPerformed === true) fail(`release-gate check ${check.name} contains an immutable authority violation`)
  if (!SAFE_MUTATIONS.has(check.mutation ?? null)) fail(`release-gate check ${check.name} contains an unsafe mutation value`)
  const tracking = trackingByName.get(check.name) || { status: 'unassigned', evidenceArtifactSha256: null, lastCheckedAt: null }
  const gateVerified = check.state === 'passed'
  const dependsOn = DEPENDENCIES[check.name] || []
  const blockedBy = dependsOn.filter((dependency) => gateStates.get(dependency) !== 'passed')
  const readyToAttempt = check.state === 'operator_blocked' && blockedBy.length === 0 && tracking.status !== 'evidence_submitted'
  const nextAction = gateVerified
    ? 'gate passed in the current release-gate run'
    : check.state === 'failed'
      ? 'fix the engineering failure before operator evidence is interpreted'
      : tracking.status === 'evidence_submitted'
        ? 'independently verify the referenced redacted artifact, then rerun the release gate'
        : readyToAttempt
          ? 'operator may begin the clearance procedure described by clearanceCriteria'
          : `resolve dependencies first: ${blockedBy.join(', ')}`
  return {
    name: check.name,
    gateState: check.state,
    resolutionState: gateVerified ? 'verified_by_release_gate' : tracking.status,
    automatedCheck: gateVerified,
    requiresOperatorEvidence: check.state === 'operator_blocked',
    requiresEngineeringFix: check.state === 'failed',
    reason: typeof check.reason === 'string' ? check.reason : null,
    clearanceCriteria: typeof check.clearanceCriteria === 'string' ? check.clearanceCriteria : null,
    evidenceArtifactSha256: tracking.evidenceArtifactSha256,
    evidenceReference: tracking.evidenceReference || null,
    referenceState: tracking.evidenceReference ? 'independently_verified_reference' : 'none',
    dependsOn,
    blockedBy,
    readyToAttempt,
    nextAction,
    lastCheckedAt: tracking.lastCheckedAt
  }
}

export function buildReleaseBlockerResolution({ report, sourceSha256 = null, tracking = null, releaseCommit, target = 'local_disposable' } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported blocker resolution target: ${target}`)
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('release-gates report must be an object')
  assertSafeReport(report, 'release-gates report')
  if (report.reportKind !== 'release_gates') fail('reportKind must be release_gates')
  if (!Array.isArray(report.checks)) fail('release-gates report checks must be an array')
  const commit = requireCommit(releaseCommit, 'releaseCommit')
  const trackingEntries = tracking ? normalizeTracking(tracking, commit) : []
  const knownCheckNames = new Set(Object.keys(DEPENDENCIES))
  const unknownCheckNames = report.checks
    .map((check) => check?.name)
    .filter((name) => typeof name !== 'string' || !knownCheckNames.has(name))
  if (unknownCheckNames.length) fail(`release-gates report contains unsupported checks: ${unknownCheckNames.join(', ')}`)
  const trackingByName = new Map(trackingEntries.map((entry) => [entry.name, entry]))
  const gateStates = new Map(report.checks.map((check) => [check?.name, check?.state]))
  const checkNames = new Set()
  const checks = report.checks.map((check) => {
    if (checkNames.has(check?.name)) fail(`duplicate release-gate check: ${check.name}`)
    checkNames.add(check?.name)
    return normalizeCheck(check, trackingByName, gateStates)
  })
  const names = new Set(checks.map((check) => check.name))
  const orphanTrackingEntries = trackingEntries.filter((entry) => !names.has(entry.name)).map((entry) => entry.name)
  if (orphanTrackingEntries.length) fail(`tracking entries do not match release-gates checks: ${orphanTrackingEntries.join(', ')}`)

  const openBlockers = checks.filter((check) => check.gateState !== 'passed')
  const passedChecks = checks.filter((check) => check.gateState === 'passed')
  const operatorBlockers = checks.filter((check) => check.gateState === 'operator_blocked')
  const unexpectedFailures = checks.filter((check) => check.gateState === 'failed')
  return {
    reportKind: 'release_blocker_resolution',
    status: unexpectedFailures.length > 0 ? 'failed' : openBlockers.length > 0 ? 'operator_blocked' : 'ready',
    trackingStatus: openBlockers.length > 0 ? 'active' : 'complete',
    target,
    releaseCommit: commit,
    sourceReportSha256: sourceSha256,
    checkCount: checks.length,
    passedCount: passedChecks.length,
    operatorBlockerCount: operatorBlockers.length,
    resolvedByAutomatedGateCount: passedChecks.length,
    openBlockerCount: openBlockers.length,
    unexpectedFailureCount: unexpectedFailures.length,
    dependencyGraphVersion: '2026-08-18.release-blockers.v1',
    nextAttemptableBlockers: checks.filter((check) => check.readyToAttempt).map((check) => check.name),
    operatorBlockers: operatorBlockers.map((check) => ({ name: check.name, status: check.resolutionState, reason: check.reason, clearanceCriteria: check.clearanceCriteria })),
    unexpectedFailures: unexpectedFailures.map((check) => ({ name: check.name, status: check.resolutionState, reason: check.reason, clearanceCriteria: check.clearanceCriteria })),
    checks,
    nextAction: openBlockers.length > 0
      ? 'Continue read-only checks and resolve each blocker with independently captured evidence; tracking metadata cannot clear a gate or grant authority.'
      : 'All automated gates passed; proceed only to the separately controlled human-evidence and release-authority evaluation path.',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_blocker_resolution_tracking_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const source = loadJson(process.env.BLOCKER_RESOLUTION_RELEASE_GATES_FILE, 'BLOCKER_RESOLUTION_RELEASE_GATES_FILE')
    const tracking = process.env.BLOCKER_RESOLUTION_TRACKING_FILE ? loadJson(process.env.BLOCKER_RESOLUTION_TRACKING_FILE, 'BLOCKER_RESOLUTION_TRACKING_FILE') : null
    const target = process.env.BLOCKER_RESOLUTION_TARGET || 'local_disposable'
    const report = buildReleaseBlockerResolution({
      report: source.value,
      sourceSha256: source.sourceSha256,
      tracking: tracking?.value || null,
      releaseCommit: process.env.BLOCKER_RESOLUTION_COMMIT,
      target
    })
    console.log(JSON.stringify({ filePath: source.filePath, trackingFilePath: tracking?.filePath || null, trackingSourceSha256: tracking?.sourceSha256 || null, ...report }, null, 2))
    process.exitCode = report.status === 'failed' ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'release_blocker_resolution',
      status: 'blocked',
      trackingStatus: 'incomplete',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'release_blocker_resolution_tracking_only'
    }, null, 2))
    process.exitCode = 1
  }
}
