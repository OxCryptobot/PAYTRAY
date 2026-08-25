import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|signature|raw.?payload|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i

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
    fail('smoke-phase2 evidence file is not a regular file')
  }
  if (stat.isSymbolicLink()) fail('smoke-phase2 evidence file must not be a symlink')
  if (!stat.isFile()) fail('smoke-phase2 evidence file must be a regular file')
}

function loadEvidence(filePath, { target, releaseCommit }) {
  if (!filePath) fail('SMOKE_PHASE2_EVIDENCE_FILE is required')
  const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
  const resolvedPath = validateEvidencePath(filePath, { label: 'smoke-phase2 evidence', target, protectedRoot })
  assertRegularNonSymlinkFile(resolvedPath)
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail('smoke-phase2 evidence file is not valid JSON')
  }
  scanSensitiveKeys(report)
  if (report.reportKind !== 'smoke_phase2_evidence') fail('smoke-phase2 evidence reportKind must be smoke_phase2_evidence')
  if (report.releaseCommit !== releaseCommit) fail('smoke-phase2 evidence releaseCommit does not match requested release commit')
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.applied !== false || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail('smoke-phase2 evidence violates immutable safety fields')
  if (report.mutation !== 'read_only' || report.authority !== 'controlled_smoke_evidence') fail('smoke-phase2 evidence violates read-only authority boundary')
  return { report, filePath: resolvedPath, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex') }
}

function verifySmokeReport(report) {
  const boundary = report.smokeBoundary
  const tokenAddress = boundary?.tokenAddress
  const checks = {
    status: report.status === 'ok',
    isolatedDatabase: boundary?.isolatedDatabase === true,
    baseSepolia: Number(boundary?.chainId) === 84532,
    mainnetDisabled: boundary?.mainnetEnabled === false,
    enabledToken: typeof tokenAddress === 'string' && ADDRESS.test(tokenAddress),
    chainTransactionNotSubmitted: boundary?.chainTransactionSubmitted === false && report.chainTransactionSubmitted !== true,
    settlementNotMutated: boundary?.settlementMutationPerformed === false && report.settlementMutationPerformed === false,
    discoveryEvidence: Number.isInteger(Number(report.experts)) && Number(report.experts) >= 1,
    outcomeReplayProtected: report.outcomeReplay === true
  }
  return { checks, ready: Object.values(checks).every(Boolean) }
}

export function buildSmokePhase2Evidence({ evidenceFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported smoke-phase2 evidence target: ${target}`)
  const commit = requireCommit(releaseCommit)
  const evidence = loadEvidence(evidenceFile, { target, releaseCommit: commit })
  const verification = verifySmokeReport(evidence.report)
  return {
    reportKind: 'smoke_phase2_evidence_verification',
    status: verification.ready ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    sourceSha256: evidence.sourceSha256,
    filePath: evidence.filePath,
    checks: verification.checks,
    nextAction: verification.ready ? 'rerun the release-gate matrix to evaluate smoke-phase2 from a fresh report' : 'rerun the isolated Base Sepolia smoke harness after correcting the failed boundary checks',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'smoke_phase2_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildSmokePhase2Evidence({
      evidenceFile: process.env.SMOKE_PHASE2_EVIDENCE_FILE,
      target: process.env.SMOKE_PHASE2_EVIDENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.SMOKE_PHASE2_EVIDENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'smoke_phase2_evidence_verification',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'smoke_phase2_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
