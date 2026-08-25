import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i
const SAFE_REDACTION_METADATA = new Set(['signatureBytesIncluded', 'signingKeyMaterialIncluded', 'identitiesIncluded'])

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && !(SAFE_REDACTION_METADATA.has(key) && child === false)) fail(`sensitive key is not allowed at ${path}.${key}`)
    scanSensitiveKeys(child, `${path}.${key}`)
  }
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

function loadJson(filePath, label) {
  if (!filePath) fail(`${label} file is required`)
  assertRegularNonSymlinkFile(filePath, label)
  const raw = fs.readFileSync(filePath, 'utf8')
  const start = raw.indexOf('{')
  if (start < 0) fail(`${label} file does not contain a JSON object`)
  let value
  try {
    value = JSON.parse(raw.slice(start))
  } catch {
    fail(`${label} file is not valid JSON`)
  }
  scanSensitiveKeys(value)
  return { value, source: filePath, sha256: createHash('sha256').update(raw, 'utf8').digest('hex') }
}

function extractVerifierStatus(report) {
  return report.verifier?.verifierStatus || report.verifierStatus || report
}

function extractReconciliationStatus(report) {
  return report.evidence || report.reconciliation || report
}

export function buildVerifierReconciliationEvidence({ verifier, reconciliation, evidenceTarget = 'unspecified' } = {}) {
  scanSensitiveKeys(verifier.value)
  scanSensitiveKeys(reconciliation.value)
  const verifierReport = extractVerifierStatus(verifier.value)
  const reconciliationReport = extractReconciliationStatus(reconciliation.value)
  const verifierReady = verifierReport.status === 'ready' || verifierReport.status === 'fresh' || verifierReport.verifierStatus?.status === 'fresh'
  const verifierStatus = verifierReport.verifierStatus?.status || verifierReport.status || 'unknown'
  const reconciliationReady = reconciliationReport.status === 'verified' || reconciliationReport.status === 'ok'
  const issueCount = Number(reconciliationReport.issueCount ?? reconciliationReport.report?.summary?.issues ?? reconciliationReport.summary?.issues ?? 0)
  const noIssues = Number.isInteger(issueCount) && issueCount === 0
  const blockers = []
  if (!verifierReady) blockers.push({ label: 'verifier', reason: `verifier status is ${verifierStatus}` })
  if (!reconciliationReady) blockers.push({ label: 'reconciliation', reason: `reconciliation status is ${reconciliationReport.status || 'unknown'}` })
  if (!noIssues) blockers.push({ label: 'reconciliation-issues', reason: `reconciliation issue count is ${issueCount}` })
  return {
    reportKind: 'verifier_reconciliation_evidence',
    status: blockers.length ? 'operator_blocked' : 'verified',
    evidenceTarget,
    authenticatedTarget: evidenceTarget === 'authenticated_target',
    checks: [
      { label: 'verifier', status: verifierStatus, ready: verifierReady, source: verifier.source, sourceSha256: verifier.sha256 },
      { label: 'reconciliation', status: reconciliationReport.status || 'unknown', ready: reconciliationReady && noIssues, issueCount, source: reconciliation.source, sourceSha256: reconciliation.sha256 }
    ],
    blockers,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'verifier_reconciliation_evidence_only',
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const verifier = loadJson(process.env.VERIFIER_OPERATIONS_FILE, 'VERIFIER_OPERATIONS_FILE')
    const reconciliation = loadJson(process.env.RECONCILIATION_EVIDENCE_FILE, 'RECONCILIATION_EVIDENCE_FILE')
    const evidence = buildVerifierReconciliationEvidence({
      verifier,
      reconciliation,
      evidenceTarget: process.env.VERIFIER_RECONCILIATION_EVIDENCE_TARGET || 'unspecified'
    })
    console.log(JSON.stringify(evidence, null, 2))
    process.exitCode = evidence.status === 'verified' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'verifier_reconciliation_evidence',
      status: 'operator_blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'verifier_reconciliation_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
