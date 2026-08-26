import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes)/i
const SAFE_REPORT_KINDS = new Set(['operations_quality', 'release_gates', 'release_blocker_resolution'])
const SAFE_STATES = new Set(['passed', 'operator_blocked', 'failed'])

function fail(message) {
  throw new Error(message)
}

function assertRegularNonSymlinkFile(artifactPath) {
  let stat
  try {
    stat = fs.lstatSync(artifactPath)
  } catch (error) {
    fail(`${artifactPath} cannot be inspected: ${error.message}`)
  }
  if (stat.isSymbolicLink()) fail(`${artifactPath} must not be a symlink`)
  if (!stat.isFile()) fail(`${artifactPath} must be a regular file`)
}

function loadArtifact(artifactPath) {
  assertRegularNonSymlinkFile(artifactPath)
  try {
    return fs.readFileSync(artifactPath, 'utf8')
  } catch (error) {
    fail(`CI matrix artifact cannot be read: ${error.message}`)
  }
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

export function validateCiMatrixArtifact({ artifactPath, expectedReportKind, content, requiredCheckNames = [] } = {}) {
  if (!artifactPath && content == null) throw new TypeError('artifactPath or content is required')
  if (!SAFE_REPORT_KINDS.has(String(expectedReportKind))) throw new TypeError('expectedReportKind is invalid')
  const raw = content == null ? loadArtifact(artifactPath) : String(content)
  let artifact
  try {
    artifact = JSON.parse(raw)
  } catch {
    fail('CI matrix artifact is not valid JSON')
  }
  assertNoSensitiveKeys(artifact)
  if (artifact.reportKind !== expectedReportKind) fail(`CI matrix artifact reportKind must be ${expectedReportKind}`)
  if (!SAFE_STATES.has(artifact.status)) fail('CI matrix artifact status is invalid')
  if (artifact.reportKind === 'release_blocker_resolution' && !['active', 'complete', 'incomplete'].includes(artifact.trackingStatus)) fail('blocker-resolution artifact trackingStatus is invalid')
  if (!Array.isArray(artifact.checks)) fail('CI matrix artifact checks must be an array')
  for (const requiredName of requiredCheckNames) {
    if (!artifact.checks.some((check) => check?.name === requiredName)) fail(`CI matrix artifact is missing required check: ${requiredName}`)
  }
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
  if (artifact.reportKind === 'release_blocker_resolution') {
    const resolvedCount = Number(artifact.resolvedByAutomatedGateCount)
    if (!Number.isInteger(resolvedCount) || resolvedCount < 0 || resolvedCount > checkCount) fail('blocker-resolution resolved count is invalid')
    if (artifact.nextAttemptableBlockers && !Array.isArray(artifact.nextAttemptableBlockers)) fail('blocker-resolution nextAttemptableBlockers must be an array')
    if (typeof artifact.dependencyGraphVersion !== 'string' || artifact.dependencyGraphVersion.trim() === '') fail('blocker-resolution dependencyGraphVersion is required')
    for (const check of artifact.checks) {
      if (!['passed', 'operator_blocked', 'failed'].includes(check?.gateState)) fail('blocker-resolution check gateState is invalid')
      if (!['verified_by_release_gate', 'unassigned', 'operator_in_progress', 'evidence_submitted', 'rejected'].includes(check?.resolutionState)) fail('blocker-resolution check resolutionState is invalid')
      if (!Array.isArray(check?.dependsOn) || !Array.isArray(check?.blockedBy)) fail('blocker-resolution dependency arrays are required')
      if (typeof check?.readyToAttempt !== 'boolean') fail('blocker-resolution readyToAttempt must be boolean')
    }
  }
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
  const [artifactPath, expectedReportKind, ...requiredCheckNames] = process.argv.slice(2)
  try {
    const result = validateCiMatrixArtifact({ artifactPath, expectedReportKind, requiredCheckNames })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: expectedReportKind || null,
      status: 'blocked',
      reason: error.message,
      authority: 'ci_matrix_artifact_verification_only',
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    process.exitCode = 1
  }
}
