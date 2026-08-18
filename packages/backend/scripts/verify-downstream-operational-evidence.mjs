import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|token(?!s$|count$)|signature|raw.?content(?!persisted$|persistence$)|reviewer.?notes|transcript|recording|audio|video)/i
const TARGET_OPERATION_CHECKS = new Set(['deploymentConfiguration', 'railwayTrialUrl', 'railwaySettings', 'database', 'paymentRpc', 'baseSepoliaPolicy', 'verifierWorker', 'outboxWorker', 'idempotencyHousekeeping'])

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${currentPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${currentPath}.${key}`)
    scanSensitiveKeys(nested, `${currentPath}.${key}`)
  }
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail('releaseCommit must be a lowercase 40-character release commit')
  return value.trim()
}

function loadReport(filePath, { label, target, releaseCommit, reportKind }) {
  if (!filePath) fail(`${label} is required`)
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(filePath, { label, target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const sourceSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  scanSensitiveKeys(report)
  if (report.reportKind !== reportKind) fail(`${label} reportKind must be ${reportKind}`)
  if (report.releaseCommit !== undefined && report.releaseCommit !== releaseCommit) fail(`${label} releaseCommit does not match the requested release commit`)
  if (report.releaseEligible === true || report.settlementAuthority === true || report.applied === true || report.deploymentPerformed === true || report.settlementMutationPerformed === true) fail(`${label} violates immutable safety fields`)
  if (!['read_only', 'none', null, undefined].includes(report.mutation)) fail(`${label} contains an unsafe mutation value`)
  return { report, resolvedPath, sourceSha256 }
}

function verifyTargetOperations(report) {
  const checks = Array.isArray(report.checks) ? report.checks : []
  const names = new Set(checks.map((check) => check?.name))
  const requiredChecksPresent = [...TARGET_OPERATION_CHECKS].every((name) => names.has(name))
  const allReady = requiredChecksPresent && checks.filter((check) => TARGET_OPERATION_CHECKS.has(check?.name)).every((check) => check.ready === true)
  return {
    status: report.status === 'ready' && allReady ? 'verified_reference' : 'blocked',
    requiredChecksPresent,
    allChecksReady: allReady,
    deploymentTarget: report.deploymentTarget || null,
    blockerCount: Array.isArray(report.blockers) ? report.blockers.length : null
  }
}

function verifyTokenMetadata(report) {
  const tokens = Array.isArray(report.tokens) ? report.tokens : []
  const allMatched = tokens.length > 0 && tokens.every((token) => token?.status === 'matched' && token.decimalsMatch === true && token.symbolMatch === true)
  const chainSafe = Number(report.chainId) === 84532 && Number(report.actualChainId) === 84532
  return {
    status: report.status === 'matched' && allMatched && chainSafe ? 'verified_reference' : 'blocked',
    chainSafe,
    tokenCount: tokens.length,
    allTokensMatched: allMatched
  }
}

export function buildDownstreamOperationalEvidence({ targetOperationsFile, tokenMetadataFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported downstream evidence target: ${target}`)
  const commit = requireCommit(releaseCommit)
  const targetOperations = loadReport(targetOperationsFile, { label: 'target operations evidence', target, releaseCommit: commit, reportKind: 'target_operations_evidence' })
  const tokenMetadata = loadReport(tokenMetadataFile, { label: 'token metadata evidence', target, releaseCommit: commit, reportKind: 'token_metadata_evidence' })
  const targetVerification = verifyTargetOperations(targetOperations.report)
  const tokenVerification = verifyTokenMetadata(tokenMetadata.report)
  const complete = targetVerification.status === 'verified_reference' && tokenVerification.status === 'verified_reference'
  return {
    reportKind: 'downstream_operational_evidence',
    status: complete ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    evidenceCount: 2,
    verifiedReferenceCount: Number(targetVerification.status === 'verified_reference') + Number(tokenVerification.status === 'verified_reference'),
    blockers: [
      { blocker: 'target-operations', ...targetVerification, sourceSha256: targetOperations.sourceSha256, filePath: targetOperations.resolvedPath },
      { blocker: 'token-metadata', ...tokenVerification, sourceSha256: tokenMetadata.sourceSha256, filePath: tokenMetadata.resolvedPath }
    ],
    nextAction: complete ? 'rerun the release-gate matrix to verify downstream checks from a fresh run' : 'resolve the blocked downstream evidence report without changing payment or release authority',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'downstream_operational_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildDownstreamOperationalEvidence({
      targetOperationsFile: process.env.DOWNSTREAM_TARGET_OPERATIONS_FILE,
      tokenMetadataFile: process.env.DOWNSTREAM_TOKEN_METADATA_FILE,
      target: process.env.DOWNSTREAM_EVIDENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.DOWNSTREAM_EVIDENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'downstream_operational_evidence',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'downstream_operational_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
