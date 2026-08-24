import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SAFE_MUTATIONS = new Set([null, 'none', 'read_only'])

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
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${path}.${key}`)
    scanSensitiveKeys(child, `${path}.${key}`)
  }
}

function assertRegularNonSymlinkFile(filePath) {
  if (!filePath) fail('BLOCKER_CLEARANCE_RELEASE_GATES_FILE is required')
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    fail('release-gates file is not a regular file')
  }
  if (stat.isSymbolicLink()) fail('release-gates file must not be a symlink')
  if (!stat.isFile()) fail('release-gates file must be a regular file')
}

function loadReleaseGates(filePath) {
  assertRegularNonSymlinkFile(filePath)
  const raw = fs.readFileSync(filePath, 'utf8')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail('release-gates file is not valid JSON')
  }
  return { report, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), filePath }
}

function normalizeBlocker(blocker, index) {
  if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) fail(`operator blocker ${index} must be an object`)
  if (typeof blocker.name !== 'string' || blocker.name.trim() === '') fail(`operator blocker ${index} requires a name`)
  if (typeof blocker.status !== 'string' || blocker.status.trim() === '') fail(`operator blocker ${blocker.name} requires a status`)
  if (typeof blocker.reason !== 'string' || blocker.reason.trim() === '') fail(`operator blocker ${blocker.name} requires a reason`)
  if (typeof blocker.clearanceCriteria !== 'string' || blocker.clearanceCriteria.trim() === '') fail(`operator blocker ${blocker.name} requires clearanceCriteria`)
  return {
    order: index + 1,
    name: blocker.name,
    status: blocker.status,
    reason: blocker.reason,
    clearanceCriteria: blocker.clearanceCriteria
  }
}

export function buildReleaseBlockerClearancePlan({ report, sourceSha256 = null, target = 'local_disposable' } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('release-gates report must be an object')
  scanSensitiveKeys(report)
  if (report.reportKind !== 'release_gates') fail('reportKind must be release_gates')
  if (!Array.isArray(report.checks)) fail('release-gates report checks must be an array')
  if (report.releaseEligible === true || report.settlementAuthority === true) fail('release-gates report contains an immutable authority violation')
  if (!SAFE_MUTATIONS.has(report.mutation ?? null)) fail('release-gates report contains an unsafe mutation value')
  if (!TARGETS.has(target)) fail(`unsupported blocker clearance target: ${target}`)

  const blockers = Array.isArray(report.operatorBlockers)
    ? report.operatorBlockers.map(normalizeBlocker)
    : report.checks.filter((check) => check?.state === 'operator_blocked').map((check, index) => normalizeBlocker(check, index))
  const unexpectedFailures = Array.isArray(report.unexpectedFailures) ? report.unexpectedFailures : []
  const criteriaComplete = blockers.length === 0 || blockers.every((blocker) => blocker.clearanceCriteria.length > 0)
  const status = unexpectedFailures.length > 0 ? 'unexpected_failure' : blockers.length > 0 ? 'operator_blocked' : 'ready'

  return {
    status,
    planStatus: criteriaComplete ? 'complete' : 'incomplete',
    target,
    sourceReportSha256: sourceSha256,
    sourceReportKind: report.reportKind,
    checkCount: Number(report.checkCount) || report.checks.length,
    blockerCount: blockers.length,
    criteriaComplete,
    unexpectedFailureCount: unexpectedFailures.length,
    blockers,
    nextAction: blockers.length === 0 && unexpectedFailures.length === 0
      ? 'Proceed to strict release-gate verification only after independent target and human evidence is bound to the exact release commit.'
      : 'Resolve each listed blocker with independently captured evidence; this plan grants no release or settlement authority.',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_blocker_clearance_plan_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { report, sourceSha256, filePath } = loadReleaseGates(process.env.BLOCKER_CLEARANCE_RELEASE_GATES_FILE)
    const target = process.env.BLOCKER_CLEARANCE_PLAN_TARGET || 'local_disposable'
    console.log(JSON.stringify({ filePath, ...buildReleaseBlockerClearancePlan({ report, sourceSha256, target }) }, null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      planStatus: 'incomplete',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'release_blocker_clearance_plan_only'
    }, null, 2))
    process.exitCode = 1
  }
}
