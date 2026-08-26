import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i
const ALLOWED_MUTATIONS = new Set([null, 'none', 'read_only'])
const STAGES = [
  { id: 'target-evidence', title: 'Authenticated target evidence', checks: ['railway-trial', 'target-operations'] },
  { id: 'target-recovery', title: 'Target backup and isolated recovery', checks: ['recovery'] },
  { id: 'fresh-verifier', title: 'Fresh verifier operations evidence', checks: ['verifier-operations', 'verifier-cursor-evidence'] },
  { id: 'reconciliation', title: 'Fresh reconciliation evidence', checks: ['reconciliation-evidence'] },
  { id: 'durable-workers', title: 'Durable outbox and housekeeping evidence', checks: ['outbox-health', 'idempotency-cleanup'] },
  { id: 'human-evidence', title: 'Shadow-review and four-role signoff evidence', checks: ['release-evidence', 'release-approval'] },
  { id: 'operator-custody', title: 'Operator key and secret-manager custody', checks: ['operator-key-custody', 'secret-manager-custody'] },
  { id: 'manifest-payload', title: 'Release manifest and signed payload', checks: ['release-manifest', 'release-payload'] },
  { id: 'authority-readiness', title: 'Controlled release-authority readiness evaluation', checks: ['release-authority-readiness'] }
]

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

function normalizeCheck(check) {
  if (!check || typeof check !== 'object' || typeof check.name !== 'string') fail('every release-gate check must have a name')
  if (!['passed', 'operator_blocked', 'unexpected_failure'].includes(check.state)) fail(`check ${check.name} has invalid state`)
  if (!ALLOWED_MUTATIONS.has(check.mutation ?? null)) fail(`check ${check.name} has unsafe mutation value`)
  if (check.releaseEligible === true || check.settlementAuthority === true) fail(`check ${check.name} contains an immutable authority violation`)
  return {
    name: check.name,
    state: check.state,
    reason: typeof check.reason === 'string' ? check.reason : null,
    expectedBlocked: check.expectedBlocked === true,
    authority: check.authority ?? null,
    mutation: check.mutation ?? null,
    releaseEligible: false,
    settlementAuthority: false
  }
}

export function buildPostAttestationSequenceReport({ report, sourceSha256 = null } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('release-gates report must be an object')
  scanSensitiveKeys(report)
  if (report.reportKind !== 'release_gates') fail('reportKind must be release_gates')
  if (!Array.isArray(report.checks)) fail('release-gates report checks must be an array')
  if (report.releaseEligible === true || report.settlementAuthority === true) fail('release-gates report contains an immutable authority violation')

  const checks = report.checks.map(normalizeCheck)
  const byName = new Map()
  for (const check of checks) {
    if (byName.has(check.name)) fail(`duplicate release-gate check: ${check.name}`)
    byName.set(check.name, check)
  }

  const orderedStages = STAGES.map((stage) => {
    const missingChecks = stage.checks.filter((name) => !byName.has(name))
    const stageChecks = stage.checks.map((name) => byName.get(name)).filter(Boolean)
    const blockers = stageChecks.filter((check) => check.state !== 'passed')
    return {
      id: stage.id,
      title: stage.title,
      status: missingChecks.length || blockers.length ? 'operator_blocked' : 'verified',
      requiredChecks: stage.checks,
      missingChecks,
      blockers
    }
  })
  const blockingChecks = orderedStages.flatMap((stage) => stage.blockers.map((check) => ({ stage: stage.id, ...check })))
  const missingChecks = orderedStages.flatMap((stage) => stage.missingChecks.map((name) => ({ stage: stage.id, name })))
  const unexpectedFailures = checks.filter((check) => check.state === 'unexpected_failure')
  const status = missingChecks.length || blockingChecks.length || unexpectedFailures.length ? 'operator_blocked' : 'verified'
  return {
    status,
    sourceReportSha256: sourceSha256,
    sequence: 'post_shadow_review_attestation',
    orderedStages,
    blockingChecks,
    missingChecks,
    unexpectedFailures,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_gate_sequence_inspection_only'
  }
}

function assertRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    fail('post-attestation release-gates file is not a regular file')
  }
  if (stat.isSymbolicLink()) fail('post-attestation release-gates file must not be a symlink')
  if (!stat.isFile()) fail('post-attestation release-gates file must be a regular file')
}

function loadReport(filePath) {
  if (!filePath) fail('POST_ATTESTATION_RELEASE_GATES_FILE is required')
  assertRegularNonSymlinkFile(filePath)
  const raw = fs.readFileSync(filePath, 'utf8')
  let report
  try {
    report = JSON.parse(raw)
  } catch {
    fail('post-attestation release-gates file is not valid JSON')
  }
  return { report, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), filePath }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { report, sourceSha256, filePath } = loadReport(process.env.POST_ATTESTATION_RELEASE_GATES_FILE)
    console.log(JSON.stringify({ filePath, ...buildPostAttestationSequenceReport({ report, sourceSha256 }) }, null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      sequence: 'post_shadow_review_attestation',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'release_gate_sequence_inspection_only'
    }, null, 2))
    process.exitCode = 1
  }
}
