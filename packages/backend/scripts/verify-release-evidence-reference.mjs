import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const REQUIRED_CHECKS = new Set(['targetOperations', 'deploymentPreflight', 'database', 'verifierOperations', 'reconciliation', 'outbox', 'webhookInbox', 'shadowReviews', 'rollbackTargets', 'humanSignoffs', 'reviewerAttestations', 'signingKey'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i

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

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail('releaseCommit must be a lowercase 40-character release commit')
  return value.trim()
}

function loadReport(filePath, { target, releaseCommit }) {
  if (!filePath) fail('RELEASE_EVIDENCE_REFERENCE_FILE is required')
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(filePath, { label: 'release-evidence reference', target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    fail('release-evidence reference file is not valid JSON')
  }
  scanSensitiveKeys(envelope)
  if (envelope.reportKind !== 'release_evidence') fail('release-evidence reportKind must be release_evidence')
  const report = envelope.bundle || envelope
  if (!report || typeof report !== 'object') fail('release-evidence bundle is required')
  if (report.status === undefined && envelope.status !== undefined) report.status = envelope.status
  if (report.releaseCommit !== releaseCommit) fail('release-evidence releaseCommit does not match requested release commit')
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail('release-evidence violates immutable safety fields')
  if (report.mutation !== 'read_only' || report.promotionStatus !== 'shadow_only' || report.approvalRequired !== true || report.signingKeyMaterialIncluded !== false) fail('release-evidence violates read-only or approval boundary')
  return { envelope, report, filePath: resolvedPath, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex') }
}

function verifyChecks(report) {
  if (!Array.isArray(report.checks)) fail('release-evidence checks must be an array')
  const names = report.checks.map((item) => item?.name)
  if (names.length !== REQUIRED_CHECKS.size || new Set(names).size !== names.length || names.some((name) => !REQUIRED_CHECKS.has(name))) fail('release-evidence checks must contain exactly the required unique check names')
  if (report.checks.some((item) => typeof item?.ready !== 'boolean' || typeof item?.reason !== 'string')) fail('release-evidence checks require boolean ready and string reason fields')
  const evidenceComplete = report.checks.every((item) => item.ready)
  if (report.evidenceComplete !== evidenceComplete) fail('release-evidence evidenceComplete does not reconcile with checks')
  if (!['blocked', 'evidence_complete_pending_release_gate'].includes(report.status)) fail('release-evidence status is not an allowed evidence-only status')
  if (report.status === 'evidence_complete_pending_release_gate' && report.evidenceComplete !== true) fail('complete release-evidence status requires evidenceComplete=true')
  if (report.status === 'blocked' && report.evidenceComplete === true) fail('blocked release-evidence status cannot be evidenceComplete=true')
  return Object.fromEntries(report.checks.map((item) => [item.name, item.ready]))
}

export function buildReleaseEvidenceReference({ evidenceFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported release-evidence target: ${target}`)
  const commit = requireCommit(releaseCommit)
  const evidence = loadReport(evidenceFile, { target, releaseCommit: commit })
  const checks = verifyChecks(evidence.report)
  const fingerprint = evidence.report.evidenceFingerprint
  const fingerprintValid = fingerprint?.algorithm === 'sha256' && fingerprint?.kind === 'release_evidence' && typeof fingerprint?.value === 'string' && /^[0-9a-f]{64}$/.test(fingerprint.value)
  return {
    reportKind: 'release_evidence_reference_verification',
    status: checks && fingerprintValid ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    sourceSha256: evidence.sourceSha256,
    filePath: evidence.filePath,
    checks,
    fingerprintValid,
    nextAction: checks && fingerprintValid ? 'rerun the release-gate matrix to evaluate release evidence from a fresh report' : 'correct the redacted release-evidence report and rerun validation; no approval or release authority is inferred',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_evidence_aggregation_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildReleaseEvidenceReference({
      evidenceFile: process.env.RELEASE_EVIDENCE_REFERENCE_FILE,
      target: process.env.RELEASE_EVIDENCE_REFERENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.RELEASE_EVIDENCE_REFERENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'release_evidence_reference_verification',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'release_evidence_aggregation_only'
    }, null, 2))
    process.exitCode = 1
  }
}
