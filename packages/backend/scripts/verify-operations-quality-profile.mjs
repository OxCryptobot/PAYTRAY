import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_STATES = new Set(['passed', 'operator_blocked', 'failed'])
const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes)/i
const EXPECTED_CHECKS = Object.freeze([
  ['quality-gate', 'backend:quality:check'],
  ['migrations', 'backend:migrations:check'],
  ['extension-contract', 'backend:extension:contract:check'],
  ['sdk-contract', 'backend:sdk:contract:check'],
  ['verifier-worker-config', 'backend:verifier:worker:check'],
  ['target-operations', 'backend:target:operations:check'],
  ['release-evidence', 'backend:release:evidence:check'],
  ['reconciliation-evidence', 'backend:reconciliation:evidence:check'],
  ['evidence-bundle', 'backend:ops:evidence:bundle:check'],
  ['release-gates', 'backend:release:gates:check'],
  ['secret-manager-custody', 'backend:release:key:secret-manager:check']
].map(([name, script], index) => Object.freeze({ index, name, script })))
const PARALLEL_SAFE_CHECKS = Object.freeze(['extension-contract', 'sdk-contract', 'verifier-worker-config'])
const SAFE_CHECK_MUTATIONS = new Set(['none', 'read_only', 'verifier_projection_only'])

function fail(message) {
  throw new Error(message)
}

function assertNoSensitiveKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSensitiveKeys(child, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed in operations-quality profile: ${location}.${key}`)
    assertNoSensitiveKeys(child, `${location}.${key}`)
  }
}

function parseContent(content) {
  try {
    return JSON.parse(String(content))
  } catch {
    fail('operations-quality profile is not valid JSON')
  }
}

function assertSafety(report) {
  for (const field of ['releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed']) {
    if (report[field] !== false) fail(`operations-quality profile ${field} must remain false`)
  }
  if (report.mutation !== 'read_only') fail('operations-quality profile mutation must be read_only')
}

export function validateOperationsQualityProfile({ artifactPath, content } = {}) {
  if (!artifactPath && content == null) throw new TypeError('artifactPath or content is required')
  const raw = content == null ? fs.readFileSync(artifactPath, 'utf8') : String(content)
  const report = parseContent(raw)
  assertNoSensitiveKeys(report)
  if (report.reportKind !== 'operations_quality_profile') fail('operations-quality profile reportKind is invalid')
  if (!SAFE_STATES.has(report.status)) fail('operations-quality profile status is invalid')
  if (report.timingBasis !== 'ci_step_diagnostic') fail('operations-quality profile timingBasis is invalid')
  if (report.authority !== 'operations_quality_profile_diagnostic_only') fail('operations-quality profile authority is invalid')
  assertSafety(report)
  if (!Number.isInteger(report.profileConcurrency) || report.profileConcurrency < 1 || report.profileConcurrency > 4) fail('operations-quality profile concurrency is invalid')
  if (!Array.isArray(report.parallelSafeChecks) || JSON.stringify(report.parallelSafeChecks) !== JSON.stringify(PARALLEL_SAFE_CHECKS)) fail('operations-quality profile parallel-safe check set is invalid')
  const expectedSerial = EXPECTED_CHECKS.filter((check) => !PARALLEL_SAFE_CHECKS.includes(check.name)).map((check) => check.name)
  if (!Array.isArray(report.serialChecks) || JSON.stringify(report.serialChecks) !== JSON.stringify(expectedSerial)) fail('operations-quality profile serial check set is invalid')
  if (!Array.isArray(report.checks) || report.checks.length !== EXPECTED_CHECKS.length) fail('operations-quality profile must contain exactly eleven checks')
  const expectedNames = EXPECTED_CHECKS.map((check) => check.name)
  const actualNames = report.checks.map((check) => check?.name)
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('operations-quality profile check order is invalid')
  if (!Number.isInteger(report.checkCount) || report.checkCount !== report.checks.length) fail('operations-quality profile checkCount does not match checks')
  for (const expected of EXPECTED_CHECKS) {
    const check = report.checks[expected.index]
    if (check.script !== expected.script) fail(`${expected.name} script binding is invalid`)
    if (check.index !== expected.index) fail(`${expected.name} index is invalid`)
    if (!SAFE_STATES.has(check.state)) fail(`${expected.name} state is invalid`)
    if (!Number.isInteger(check.exitCode)) fail(`${expected.name} exitCode is invalid`)
    if (!Number.isFinite(check.elapsedMs) || check.elapsedMs < 0) fail(`${expected.name} elapsedMs is invalid`)
    if (check.timingBasis !== 'ci_step_diagnostic') fail(`${expected.name} timingBasis is invalid`)
    if (check.releaseEligible !== false || check.settlementAuthority !== false) fail(`${expected.name} authority fields must remain false`)
    if (check.mutation !== null && !SAFE_CHECK_MUTATIONS.has(check.mutation)) fail(`${expected.name} mutation is invalid`)
    if (check.state === 'passed' && check.expectedBlocked !== false) fail(`${expected.name} passed state cannot be expected-blocked`)
    if (check.state === 'operator_blocked' && check.expectedBlocked !== true) fail(`${expected.name} operator-blocked state must be expected-blocked`)
    if (check.state === 'failed' && check.expectedBlocked !== false) fail(`${expected.name} failed state cannot be expected-blocked`)
  }
  const counts = [report.passedCount, report.operatorBlockerCount, report.unexpectedFailureCount]
  if (!counts.every(Number.isInteger) || counts.some((value) => value < 0)) fail('operations-quality profile counts are invalid')
  if (counts.reduce((sum, value) => sum + value, 0) !== report.checkCount) fail('operations-quality profile counts do not reconcile')
  const derivedCounts = {
    passed: report.checks.filter((check) => check.state === 'passed').length,
    operatorBlocked: report.checks.filter((check) => check.state === 'operator_blocked').length,
    failed: report.checks.filter((check) => check.state === 'failed').length
  }
  if (report.passedCount !== derivedCounts.passed || report.operatorBlockerCount !== derivedCounts.operatorBlocked || report.unexpectedFailureCount !== derivedCounts.failed) fail('operations-quality profile state/count reconciliation is invalid')
  const expectedBlockerNames = report.checks.filter((check) => check.state === 'operator_blocked').map((check) => check.name)
  const actualBlockerNames = Array.isArray(report.operatorBlockers) ? report.operatorBlockers.map((blocker) => blocker?.name) : []
  if (JSON.stringify(actualBlockerNames) !== JSON.stringify(expectedBlockerNames)) fail('operations-quality profile operator blockers do not reconcile with check states')
  const expectedFailureNames = report.checks.filter((check) => check.state === 'failed').map((check) => check.name)
  const actualFailureNames = Array.isArray(report.unexpectedFailures) ? report.unexpectedFailures.map((failure) => failure?.name) : []
  if (JSON.stringify(actualFailureNames) !== JSON.stringify(expectedFailureNames)) fail('operations-quality profile unexpected failures do not reconcile with check states')
  const expectedStatus = derivedCounts.failed > 0 ? 'failed' : derivedCounts.operatorBlocked > 0 ? 'operator_blocked' : 'passed'
  if (report.status !== expectedStatus) fail('operations-quality profile status does not reconcile with check states')
  return {
    status: 'verified',
    reportKind: report.reportKind,
    reportStatus: report.status,
    checkCount: report.checkCount,
    passedCount: report.passedCount,
    operatorBlockerCount: report.operatorBlockerCount,
    unexpectedFailureCount: report.unexpectedFailureCount,
    timingBasis: report.timingBasis,
    authority: report.authority,
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [artifactPath, outputPath] = process.argv.slice(2)
  const result = validateOperationsQualityProfile({ artifactPath })
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
}
