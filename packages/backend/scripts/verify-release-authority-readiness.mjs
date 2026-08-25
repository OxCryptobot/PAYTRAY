import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SENSITIVE_KEY = /(?:private.?key|secret.?value|password|authorization|cookie|jwt|token|signature(?:bytes|material)?|raw.?content|transcript|recording|audio|video)/i
const SAFE_BOOLEAN_KEYS = new Set(['signatureBytesIncluded', 'signingKeyMaterialIncluded', 'identitiesIncluded', 'privateKeyMaterialIncluded', 'publicKeyMaterialIncluded', 'signatureMaterialIncluded', 'custodyManifestMaterialIncluded', 'signatureValid', 'releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed', 'mutation'])

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) return value.flatMap((item, index) => scanSensitiveKeys(item, `${currentPath}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => {
    const safe = SAFE_BOOLEAN_KEYS.has(key) && (typeof child === 'boolean' || child === 'string')
    const forbidden = SENSITIVE_KEY.test(key) && !safe
    return [...(forbidden ? [`${currentPath}.${key}`] : []), ...scanSensitiveKeys(child, `${currentPath}.${key}`)]
  })
}

function assertSafeEvidence(value, label) {
  const sensitivePaths = scanSensitiveKeys(value)
  if (sensitivePaths.length) fail(`${label} contains sensitive keys: ${sensitivePaths.join(', ')}`)
  if (value?.releaseEligible === true || value?.settlementAuthority === true || value?.deploymentPerformed === true || value?.settlementMutationPerformed === true || value?.mutation === 'write') fail(`${label} contains an authority or mutation violation`)
}

function requireCommit(value, field = 'releaseCommit') {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail(`${field} must be a lowercase 40-character release commit`)
  return value.trim()
}

function assertRegularNonSymlinkFile(filePath, label) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    fail(`${label} file is not a regular file`)
  }
  if (stat.isSymbolicLink()) fail(`${label} file must not be a symlink`)
  if (!stat.isFile()) fail(`${label} file must be a regular file`)
}

function readReport(filePath, label, { target, protectedRoot }) {
  assertRegularNonSymlinkFile(filePath, label)
  const resolvedPath = validateEvidencePath(filePath, { label, target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  assertSafeEvidence(value, label)
  return { value, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), path: resolvedPath }
}

function evaluate(name, ready, reason, evidence = null) {
  return { name, ready: ready === true, reason, evidence }
}

export function buildReleaseAuthorityReadiness({ releaseApproval, releaseEvidence, shadowReviewStatus, cryptographicSequence, signedPayload, releaseCommit, target = 'local_disposable' } = {}) {
  if (!TARGETS.has(target)) fail('unsupported release-authority target')
  const commit = requireCommit(releaseCommit || releaseApproval?.releaseCommit || releaseEvidence?.releaseCommit, 'releaseCommit')
  assertSafeEvidence(releaseApproval, 'release approval')
  assertSafeEvidence(releaseEvidence, 'release evidence')
  assertSafeEvidence(shadowReviewStatus, 'shadow review status')
  assertSafeEvidence(cryptographicSequence, 'cryptographic sequence')
  assertSafeEvidence(signedPayload, 'signed payload')

  const checks = [
    evaluate('releaseCommit', [releaseApproval?.releaseCommit, releaseEvidence?.releaseCommit, cryptographicSequence?.releaseCommit, signedPayload?.releaseCommit].filter(Boolean).every((value) => value === commit), 'all supplied evidence is bound to the exact release commit'),
    evaluate('releaseApproval', releaseApproval?.status === 'approved' && releaseApproval?.eligible === true, 'controlled release approval must be approved and eligible'),
    evaluate('releaseEvidence', releaseEvidence?.evidenceComplete === true, 'release evidence must be complete'),
    evaluate('shadowReviews', shadowReviewStatus?.status === 'complete' && shadowReviewStatus?.pendingCount === 0 && shadowReviewStatus?.expectedRunCount === shadowReviewStatus?.observedRunCount, 'all six shadow reviews must be terminal with none pending or missing'),
    evaluate('cryptographicSequence', cryptographicSequence?.status === 'verified' && cryptographicSequence?.cryptographicSequenceComplete === true, 'cryptographic release sequence must be complete'),
    evaluate('signedPayload', signedPayload?.status === 'verified' && signedPayload?.signatureValid === true && signedPayload?.evidenceReady === true, 'canonical signed payload must verify'),
    evaluate('safety', releaseApproval?.releaseEligible !== true && releaseEvidence?.releaseEligible !== true && cryptographicSequence?.releaseEligible !== true && signedPayload?.releaseEligible !== true, 'all evidence sources must remain non-authoritative')
  ]
  const readyForControlledEvaluation = checks.every((check) => check.ready)
  return {
    status: readyForControlledEvaluation ? 'ready_for_controlled_release_evaluation' : 'blocked',
    target,
    releaseCommit: commit,
    checks,
    blockers: checks.filter((check) => !check.ready).map(({ name, reason }) => ({ name, reason })),
    readyForControlledEvaluation,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_authority_readiness_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const target = process.env.RELEASE_AUTHORITY_TARGET || 'local_disposable'
    const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
    const options = { target, protectedRoot }
    const reports = {
      releaseApproval: readReport(process.env.RELEASE_APPROVAL_FILE, 'release approval', options),
      releaseEvidence: readReport(process.env.RELEASE_EVIDENCE_FILE, 'release evidence', options),
      shadowReviewStatus: readReport(process.env.SHADOW_REVIEW_STATUS_FILE, 'shadow review status', options),
      cryptographicSequence: readReport(process.env.CRYPTOGRAPHIC_SEQUENCE_FILE, 'cryptographic sequence', options),
      signedPayload: readReport(process.env.SIGNED_RELEASE_PAYLOAD_FILE, 'signed release payload', options)
    }
    const report = buildReleaseAuthorityReadiness({
      releaseApproval: reports.releaseApproval.value,
      releaseEvidence: reports.releaseEvidence.value,
      shadowReviewStatus: reports.shadowReviewStatus.value,
      cryptographicSequence: reports.cryptographicSequence.value,
      signedPayload: reports.signedPayload.value,
      releaseCommit: process.env.RELEASE_AUTHORITY_COMMIT,
      target
    })
    console.log(JSON.stringify({
      ...report,
      sourceHashes: Object.fromEntries(Object.entries(reports).map(([key, value]) => [key, value.sourceSha256]))
    }, null, 2))
    process.exitCode = report.status === 'ready_for_controlled_release_evaluation' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', reason: error instanceof Error ? error.message : String(error), releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false, authority: 'release_authority_readiness_evidence_only' }, null, 2))
    process.exitCode = 1
  }
}
