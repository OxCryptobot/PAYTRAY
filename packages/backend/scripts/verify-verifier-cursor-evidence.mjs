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

function summarizeCursor(report) {
  const verifier = report.verifier || {}
  const cursor = verifier.cursor || null
  const verifierStatus = verifier.verifierStatus || {}
  const lastScannedBlock = cursor?.last_scanned_block == null ? null : Number(cursor.last_scanned_block)
  const cursorTimestamp = cursor?.updated_at ? Date.parse(cursor.updated_at) : NaN
  const checks = [
    { label: 'report-status', ready: report.status === 'ready', status: report.status || 'unknown', reason: report.status === 'ready' ? 'verifier operations report is ready' : report.reason || 'verifier operations report is not ready' },
    { label: 'chain-policy', ready: verifier.chainId === 84532 && verifier.configured === true, status: verifier.chainId === 84532 && verifier.configured === true ? 'base_sepolia_configured' : 'invalid_or_unconfigured', reason: verifier.chainId === 84532 && verifier.configured === true ? 'Base Sepolia verifier is configured' : 'verifier must be configured for Base Sepolia chain ID 84532' },
    { label: 'cursor-status', ready: verifierStatus.status === 'fresh' && verifierStatus.ready === true, status: verifierStatus.status || 'unknown', reason: verifierStatus.status === 'fresh' && verifierStatus.ready === true ? 'durable verifier cursor is fresh' : verifierStatus.reason || 'durable verifier cursor must be fresh' },
    { label: 'cursor-metadata', ready: Number.isSafeInteger(lastScannedBlock) && lastScannedBlock >= 0 && Number.isFinite(cursorTimestamp), status: Number.isSafeInteger(lastScannedBlock) && lastScannedBlock >= 0 && Number.isFinite(cursorTimestamp) ? 'valid' : 'invalid_or_missing', reason: Number.isSafeInteger(lastScannedBlock) && lastScannedBlock >= 0 && Number.isFinite(cursorTimestamp) ? 'cursor block and updated_at are valid' : 'cursor must include a nonnegative integer last_scanned_block and parseable updated_at' },
    { label: 'unlinked-evidence', ready: Number(verifier.unlinkedEvidenceCount) === 0, status: Number(verifier.unlinkedEvidenceCount) === 0 ? 'clean' : 'attention', reason: Number(verifier.unlinkedEvidenceCount) === 0 ? 'all chain evidence is linked' : 'unlinked chain evidence remains' }
  ]
  return { verifier, cursor, checks }
}

export function buildVerifierCursorEvidence({ operations, evidenceTarget = 'unspecified' } = {}) {
  scanSensitiveKeys(operations.value)
  const { verifier, cursor, checks } = summarizeCursor(operations.value)
  const blockers = checks.filter((check) => !check.ready).map(({ label, reason }) => ({ label, reason }))
  return {
    status: blockers.length ? 'operator_blocked' : 'verified',
    evidenceTarget,
    authenticatedTarget: evidenceTarget === 'authenticated_target',
    chainId: verifier.chainId || null,
    cursor: cursor ? { lastScannedBlock: Number(cursor.last_scanned_block), updatedAt: cursor.updated_at } : null,
    checks,
    blockers,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'verifier_cursor_evidence_only',
    source: operations.source,
    sourceSha256: operations.sha256
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const operations = loadJson(process.env.VERIFIER_OPERATIONS_FILE, 'VERIFIER_OPERATIONS_FILE')
    const evidence = buildVerifierCursorEvidence({
      operations,
      evidenceTarget: process.env.VERIFIER_CURSOR_EVIDENCE_TARGET || 'unspecified'
    })
    console.log(JSON.stringify(evidence, null, 2))
    process.exitCode = evidence.status === 'verified' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      status: 'operator_blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'verifier_cursor_evidence_only'
    }, null, 2))
    process.exitCode = 1
  }
}
