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

function loadJson(filePath, label) {
  if (!filePath) fail(`${label} file is required`)
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
  return {
    value,
    source: filePath,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex')
  }
}

function summarizeCheck(label, loaded, expectedStatus) {
  const report = loaded.value
  const status = report.status
  return {
    label,
    status,
    expectedStatus,
    ready: status === expectedStatus,
    reason: status === expectedStatus ? 'check passed' : report.reason || `${label} status must be ${expectedStatus}`,
    source: loaded.source,
    sourceSha256: loaded.sha256,
    authority: report.authority || null,
    mutation: report.mutation || 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    details: report
  }
}

export function buildDurableWorkerEvidence({ outboxHealth, outboxWorker, idempotencyCleanup, evidenceTarget = 'unspecified' } = {}) {
  const checks = [
    summarizeCheck('outbox-health', outboxHealth, 'ok'),
    summarizeCheck('outbox-worker', outboxWorker, 'ready'),
    summarizeCheck('idempotency-cleanup', idempotencyCleanup, 'ready')
  ]
  const blockers = checks.filter((check) => !check.ready).map((check) => ({ label: check.label, reason: check.reason }))
  const authenticatedTarget = evidenceTarget === 'authenticated_target'
  return {
    reportKind: 'durable_worker_evidence',
    status: blockers.length ? 'operator_blocked' : 'verified',
    evidenceTarget,
    authenticatedTarget,
    checks: checks.map(({ details, ...check }) => check),
    blockers,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'durable_worker_evidence_aggregation_only',
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const outboxHealth = loadJson(process.env.OUTBOX_HEALTH_FILE, 'OUTBOX_HEALTH_FILE')
    const outboxWorker = loadJson(process.env.OUTBOX_WORKER_CONFIG_FILE, 'OUTBOX_WORKER_CONFIG_FILE')
    const idempotencyCleanup = loadJson(process.env.IDEMPOTENCY_CLEANUP_CONFIG_FILE, 'IDEMPOTENCY_CLEANUP_CONFIG_FILE')
    console.log(JSON.stringify(buildDurableWorkerEvidence({
      outboxHealth,
      outboxWorker,
      idempotencyCleanup,
      evidenceTarget: process.env.DURABLE_WORKER_EVIDENCE_TARGET || 'unspecified'
    }), null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'durable_worker_evidence',
      status: 'operator_blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'durable_worker_evidence_aggregation_only'
    }, null, 2))
    process.exitCode = 1
  }
}
