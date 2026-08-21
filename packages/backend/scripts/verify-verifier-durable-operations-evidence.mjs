import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
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
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${currentPath}.${key}`)
    scanSensitiveKeys(nested, `${currentPath}.${key}`)
  }
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail('releaseCommit must be a lowercase 40-character release commit')
  return value.trim()
}

function loadEvidence(filePath, { label, target, releaseCommit, reportKind }) {
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
  if (!['read_only', 'none', null, undefined, 'isolated_recovery_only', 'backup_only'].includes(report.mutation)) fail(`${label} contains an unsafe mutation value`)
  return { report, resolvedPath, sourceSha256 }
}

function verifyRecovery(report) {
  const status = report.status === 'verified' && report.restore?.status === 'verified' && Number(report.restore?.migrationCount) === 20
  return { status: status ? 'verified_reference' : 'blocked', migrationCount: Number(report.restore?.migrationCount || 0), restoredDatabase: report.restore?.database || null }
}

function verifyVerifierReconciliation(report) {
  const verifier = report.checks?.find((check) => check.label === 'verifier')
  const reconciliation = report.checks?.find((check) => check.label === 'reconciliation')
  const fresh = ['fresh', 'ready'].includes(verifier?.status) && verifier?.ready === true
  const reconciled = ['verified', 'ok'].includes(reconciliation?.status) && reconciliation?.ready === true && Number(reconciliation?.issueCount) === 0
  return { status: fresh && reconciled ? 'verified_reference' : 'blocked', verifierStatus: verifier?.status || null, reconciliationStatus: reconciliation?.status || null, issueCount: Number(reconciliation?.issueCount || 0) }
}

function verifyDurableWorker(report) {
  const checks = Array.isArray(report.checks) ? report.checks : []
  const expected = new Map([['outbox-health', 'ok'], ['outbox-worker', 'ready'], ['idempotency-cleanup', 'ready']])
  const ready = [...expected.entries()].every(([label, status]) => checks.some((check) => check.label === label && check.ready === true && check.status === status))
  return { status: report.status === 'verified' && ready ? 'verified_reference' : 'blocked', checks: checks.map((check) => ({ label: check.label, status: check.status, ready: check.ready })) }
}

export function buildVerifierDurableOperationsEvidence({ recoveryFile, verifierReconciliationFile, durableWorkerFile, target = 'local_disposable', releaseCommit } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported verifier/durable evidence target: ${target}`)
  const commit = requireCommit(releaseCommit)
  const recovery = loadEvidence(recoveryFile, { label: 'recovery evidence', target, releaseCommit: commit, reportKind: 'recovery_evidence' })
  const verifierReconciliation = loadEvidence(verifierReconciliationFile, { label: 'verifier/reconciliation evidence', target, releaseCommit: commit, reportKind: 'verifier_reconciliation_evidence' })
  const durableWorker = loadEvidence(durableWorkerFile, { label: 'durable-worker evidence', target, releaseCommit: commit, reportKind: 'durable_worker_evidence' })
  const checks = [
    { blocker: 'recovery', ...verifyRecovery(recovery.report), sourceSha256: recovery.sourceSha256, filePath: recovery.resolvedPath },
    { blocker: 'verifier-reconciliation', ...verifyVerifierReconciliation(verifierReconciliation.report), sourceSha256: verifierReconciliation.sourceSha256, filePath: verifierReconciliation.resolvedPath },
    { blocker: 'durable-workers', ...verifyDurableWorker(durableWorker.report), sourceSha256: durableWorker.sourceSha256, filePath: durableWorker.resolvedPath }
  ]
  const complete = checks.every((check) => check.status === 'verified_reference')
  return {
    reportKind: 'verifier_durable_operations_evidence',
    status: complete ? 'verified_reference' : 'blocked',
    target,
    releaseCommit: commit,
    evidenceCount: checks.length,
    verifiedReferenceCount: checks.filter((check) => check.status === 'verified_reference').length,
    checks,
    nextAction: complete ? 'rerun the release-gate matrix to verify recovery, verifier, reconciliation, outbox, and idempotency checks from a fresh run' : 'resolve the blocked operational evidence without changing payment or release authority',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'verifier_durable_operations_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildVerifierDurableOperationsEvidence({
      recoveryFile: process.env.VERIFIER_DURABLE_RECOVERY_FILE,
      verifierReconciliationFile: process.env.VERIFIER_RECONCILIATION_FILE,
      durableWorkerFile: process.env.DURABLE_WORKER_EVIDENCE_FILE,
      target: process.env.VERIFIER_DURABLE_EVIDENCE_TARGET || 'local_disposable',
      releaseCommit: process.env.VERIFIER_DURABLE_EVIDENCE_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified_reference' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'verifier_durable_operations_evidence',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'verifier_durable_operations_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
