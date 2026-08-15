import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes)/i
const SAFE_REPORT_KINDS = new Set(['operations_quality', 'release_gates'])
const SAFE_STATES = new Set(['passed', 'operator_blocked', 'failed'])

function fail(message) {
  throw new Error(message)
}

function assertNoSensitiveKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed in CI matrix artifact: ${path}.${key}`)
    assertNoSensitiveKeys(child, `${path}.${key}`)
  }
}

export function validateCiMatrixArtifact({ artifactPath, expectedReportKind, content } = {}) {
  if (!artifactPath && content == null) throw new TypeError('artifactPath or content is required')
  if (!SAFE_REPORT_KINDS.has(String(expectedReportKind))) throw new TypeError('expectedReportKind is invalid')
  const raw = content == null ? fs.readFileSync(artifactPath, 'utf8') : String(content)
  let artifact
  try {
    artifact = JSON.parse(raw)
  } catch {
    fail('CI matrix artifact is not valid JSON')
  }
  assertNoSensitiveKeys(artifact)
  if (artifact.reportKind !== expectedReportKind) fail(`CI matrix artifact reportKind must be ${expectedReportKind}`)
  if (!SAFE_STATES.has(artifact.status)) fail('CI matrix artifact status is invalid')
  if (!Array.isArray(artifact.checks)) fail('CI matrix artifact checks must be an array')
  const checkCount = Number(artifact.checkCount)
  if (!Number.isInteger(checkCount) || checkCount !== artifact.checks.length) fail('CI matrix artifact checkCount does not match checks')
  const passedCount = Number(artifact.passedCount)
  const operatorBlockerCount = Number(artifact.operatorBlockerCount)
  const unexpectedFailureCount = Number(artifact.unexpectedFailureCount)
  if (![passedCount, operatorBlockerCount, unexpectedFailureCount].every(Number.isInteger)) fail('CI matrix artifact counts must be integers')
  if (passedCount + operatorBlockerCount + unexpectedFailureCount !== checkCount) fail('CI matrix artifact counts do not reconcile')
  if (!Array.isArray(artifact.operatorBlockers) || !Array.isArray(artifact.unexpectedFailures)) fail('CI matrix artifact blocker arrays are required')
  if (artifact.operatorBlockers.length !== operatorBlockerCount) fail('CI matrix operator blocker count does not match blockers')
  if (artifact.unexpectedFailures.length !== unexpectedFailureCount) fail('CI matrix unexpected failure count does not match failures')
  for (const field of ['releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed']) {
    if (artifact[field] !== false) fail(`CI matrix artifact ${field} must remain false`)
  }
  if (artifact.mutation !== 'read_only') fail('CI matrix artifact mutation must be read_only')
  return {
    status: 'verified',
    reportKind: artifact.reportKind,
    reportStatus: artifact.status,
    checkCount,
    passedCount,
    operatorBlockerCount,
    unexpectedFailureCount,
    authority: artifact.authority || null,
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [artifactPath, expectedReportKind] = process.argv.slice(2)
  const result = validateCiMatrixArtifact({ artifactPath, expectedReportKind })
  console.log(JSON.stringify(result, null, 2))
}
