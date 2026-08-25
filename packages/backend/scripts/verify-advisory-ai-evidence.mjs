import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content(?!persisted$|persistence$)|reviewer.?notes|transcript|recording|audio|video)/i

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

function assertRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    fail('advisory-AI evidence file is not a regular file')
  }
  if (stat.isSymbolicLink()) fail('advisory-AI evidence file must not be a symlink')
  if (!stat.isFile()) fail('advisory-AI evidence file must be a regular file')
}

function loadEvidence(filePath, { target, releaseCommit }) {
  if (!filePath) fail('ADVISORY_AI_EVIDENCE_FILE is required')
  assertRegularNonSymlinkFile(filePath)
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(filePath, { label: 'advisory-AI evidence', target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const sourceSha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail('advisory-AI evidence file is not valid JSON')
  }
  scanSensitiveKeys(report)
  if (report.reportKind !== 'advisory_ai_evidence') fail('advisory-AI evidence reportKind must be advisory_ai_evidence')
  if (report.releaseCommit !== undefined && report.releaseCommit !== releaseCommit) fail('advisory-AI evidence releaseCommit does not match the requested release commit')
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.applied !== false || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail('advisory-AI evidence violates immutable safety fields')
  if (report.mutation !== 'read_only' || report.promotionStatus !== 'shadow_only' || report.humanOverrideRequired !== true || report.rawContentPersisted !== false) fail('advisory-AI evidence violates shadow-only boundary')
  return { report, filePath: resolvedPath, sourceSha256 }
}

function verifyCapabilities(report) {
  const capabilities = report.capabilities
  const latency = Number(capabilities?.maxLatencyMs)
  const cost = Number(capabilities?.maxCostMicrounits)
  const retrieval = Number(capabilities?.maxRetrievalItems)
  const retention = Number(capabilities?.retentionDays)
  return {
    enabled: capabilities?.enabled === true,
    providerConfigured: capabilities?.providerConfigured === true && typeof capabilities?.providerName === 'string' && capabilities.providerName.trim() !== '' && typeof capabilities?.modelName === 'string' && capabilities.modelName.trim() !== '',
    latencyBudgetValid: Number.isInteger(latency) && latency >= 1 && latency <= 120000,
    costBudgetValid: Number.isInteger(cost) && cost >= 0,
    retrievalBudgetValid: Number.isInteger(retrieval) && retrieval >= 1 && retrieval <= 100,
    retentionBudgetValid: Number.isInteger(retention) && retention >= 1 && retention <= 3650,
    rawContentPersistence: capabilities?.rawContentPersistence === false,
    humanReviewRequired: capabilities?.humanReviewRequired === true,
    promotionStatus: capabilities?.promotionStatus === 'shadow_only',
    settlementAuthority: capabilities?.settlementAuthority === false,
    applied: capabilities?.applied === false,
    mutation: capabilities?.mutation === 'read_only'
  }
}

export function buildAdvisoryAiEvidence({ evidenceFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported advisory-AI evidence target: ${target}`)
  const commit = requireCommit(releaseCommit)
  const evidence = loadEvidence(evidenceFile, { target, releaseCommit: commit })
  const capabilityChecks = verifyCapabilities(evidence.report)
  const checksPass = evidence.report.status === 'ready' && Object.values(capabilityChecks).every(Boolean)
  return {
    reportKind: 'advisory_ai_evidence_verification',
    status: checksPass ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    sourceSha256: evidence.sourceSha256,
    filePath: evidence.filePath,
    capabilityChecks,
    nextAction: checksPass ? 'rerun the release-gate matrix to verify advisory-ai and downstream checks from a fresh run' : 'configure or correct the bounded advisory-AI capability report without enabling promotion or persisting raw content',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'advisory_ai_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildAdvisoryAiEvidence({
      evidenceFile: process.env.ADVISORY_AI_EVIDENCE_FILE,
      target: process.env.ADVISORY_AI_EVIDENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.ADVISORY_AI_EVIDENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'advisory_ai_evidence_verification',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'advisory_ai_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
