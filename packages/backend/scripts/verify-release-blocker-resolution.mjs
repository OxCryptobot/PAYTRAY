import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const COMMIT40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const SAFE_MUTATIONS = new Set([null, 'none', 'read_only'])
const TRACKING_STATUSES = new Set(['unassigned', 'operator_in_progress', 'evidence_submitted', 'rejected'])
const SENSITIVE_KEY = /(?:private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i

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

function assertSafeReport(report, label) {
  scanSensitiveKeys(report)
  if (report?.releaseEligible === true || report?.settlementAuthority === true || report?.deploymentPerformed === true || report?.settlementMutationPerformed === true) fail(`${label} contains an immutable authority violation`)
  if (!SAFE_MUTATIONS.has(report?.mutation ?? null)) fail(`${label} contains an unsafe mutation value`)
}

function requireCommit(value, field = 'releaseCommit') {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail(`${field} must be a lowercase 40-character release commit`)
  return value.trim()
}

function loadJson(filePath, label) {
  if (!filePath) fail(`${label} is required`)
  const raw = fs.readFileSync(filePath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  return { value, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), filePath }
}

function normalizeTracking(tracking, commit) {
  if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)) fail('resolution tracking must be an object')
  scanSensitiveKeys(tracking)
  if (tracking.reportKind !== 'release_blocker_resolution_tracking') fail('tracking reportKind must be release_blocker_resolution_tracking')
  if (tracking.releaseEligible === true || tracking.settlementAuthority === true) fail('resolution tracking contains an immutable authority violation')
  if (!SAFE_MUTATIONS.has(tracking.mutation ?? null)) fail('resolution tracking contains an unsafe mutation value')
  if (tracking.releaseCommit !== undefined && requireCommit(tracking.releaseCommit, 'tracking releaseCommit') !== commit) fail('tracking releaseCommit does not match the release-gates commit')
  if (!Array.isArray(tracking.entries)) fail('resolution tracking entries must be an array')

  const seen = new Set()
  return tracking.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`tracking entry ${index} must be an object`)
    if (typeof entry.name !== 'string' || entry.name.trim() === '') fail(`tracking entry ${index} requires a name`)
    const name = entry.name.trim()
    if (seen.has(name)) fail(`duplicate tracking entry: ${name}`)
    seen.add(name)
    const status = entry.status || 'unassigned'
    if (!TRACKING_STATUSES.has(status)) fail(`tracking entry ${name} has unsupported status`)
    if (entry.evidenceArtifactSha256 !== undefined && (typeof entry.evidenceArtifactSha256 !== 'string' || !SHA256.test(entry.evidenceArtifactSha256))) fail(`tracking entry ${name} evidenceArtifactSha256 must be a 64-character lowercase SHA-256`)
    return {
      name,
      status,
      evidenceArtifactSha256: entry.evidenceArtifactSha256 || null,
      lastCheckedAt: typeof entry.lastCheckedAt === 'string' && !Number.isNaN(Date.parse(entry.lastCheckedAt)) ? entry.lastCheckedAt : null
    }
  })
}

function normalizeCheck(check, trackingByName) {
  if (!check || typeof check !== 'object' || typeof check.name !== 'string') fail('every release-gate check must have a name')
  if (!['passed', 'operator_blocked', 'failed'].includes(check.state)) fail(`release-gate check ${check.name} has invalid state`)
  if (check.releaseEligible === true || check.settlementAuthority === true || check.deploymentPerformed === true || check.settlementMutationPerformed === true) fail(`release-gate check ${check.name} contains an immutable authority violation`)
  if (!SAFE_MUTATIONS.has(check.mutation ?? null)) fail(`release-gate check ${check.name} contains an unsafe mutation value`)
  const tracking = trackingByName.get(check.name) || { status: 'unassigned', evidenceArtifactSha256: null, lastCheckedAt: null }
  const gateVerified = check.state === 'passed'
  return {
    name: check.name,
    gateState: check.state,
    resolutionState: gateVerified ? 'verified_by_release_gate' : tracking.status,
    automatedCheck: gateVerified,
    requiresOperatorEvidence: check.state === 'operator_blocked',
    requiresEngineeringFix: check.state === 'failed',
    reason: typeof check.reason === 'string' ? check.reason : null,
    clearanceCriteria: typeof check.clearanceCriteria === 'string' ? check.clearanceCriteria : null,
    evidenceArtifactSha256: tracking.evidenceArtifactSha256,
    lastCheckedAt: tracking.lastCheckedAt
  }
}

export function buildReleaseBlockerResolution({ report, sourceSha256 = null, tracking = null, releaseCommit, target = 'local_disposable' } = {}) {
  if (!TARGETS.has(target)) fail(`unsupported blocker resolution target: ${target}`)
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('release-gates report must be an object')
  assertSafeReport(report, 'release-gates report')
  if (report.reportKind !== 'release_gates') fail('reportKind must be release_gates')
  if (!Array.isArray(report.checks)) fail('release-gates report checks must be an array')
  const commit = requireCommit(releaseCommit, 'releaseCommit')
  const trackingEntries = tracking ? normalizeTracking(tracking, commit) : []
  const trackingByName = new Map(trackingEntries.map((entry) => [entry.name, entry]))
  const checkNames = new Set()
  const checks = report.checks.map((check) => {
    if (checkNames.has(check?.name)) fail(`duplicate release-gate check: ${check.name}`)
    checkNames.add(check?.name)
    return normalizeCheck(check, trackingByName)
  })
  const names = new Set(checks.map((check) => check.name))
  const orphanTrackingEntries = trackingEntries.filter((entry) => !names.has(entry.name)).map((entry) => entry.name)
  if (orphanTrackingEntries.length) fail(`tracking entries do not match release-gates checks: ${orphanTrackingEntries.join(', ')}`)

  const openBlockers = checks.filter((check) => check.gateState !== 'passed')
  const unexpectedFailures = checks.filter((check) => check.gateState === 'failed')
  return {
    status: unexpectedFailures.length > 0 ? 'failed' : openBlockers.length > 0 ? 'operator_blocked' : 'ready',
    trackingStatus: openBlockers.length > 0 ? 'active' : 'complete',
    target,
    releaseCommit: commit,
    sourceReportSha256: sourceSha256,
    checkCount: checks.length,
    resolvedByAutomatedGateCount: checks.filter((check) => check.automatedCheck).length,
    openBlockerCount: openBlockers.length,
    unexpectedFailureCount: unexpectedFailures.length,
    checks,
    nextAction: openBlockers.length > 0
      ? 'Continue read-only checks and resolve each blocker with independently captured evidence; tracking metadata cannot clear a gate or grant authority.'
      : 'All automated gates passed; proceed only to the separately controlled human-evidence and release-authority evaluation path.',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'release_blocker_resolution_tracking_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const source = loadJson(process.env.BLOCKER_RESOLUTION_RELEASE_GATES_FILE, 'BLOCKER_RESOLUTION_RELEASE_GATES_FILE')
    const tracking = process.env.BLOCKER_RESOLUTION_TRACKING_FILE ? loadJson(process.env.BLOCKER_RESOLUTION_TRACKING_FILE, 'BLOCKER_RESOLUTION_TRACKING_FILE') : null
    const target = process.env.BLOCKER_RESOLUTION_TARGET || 'local_disposable'
    const report = buildReleaseBlockerResolution({
      report: source.value,
      sourceSha256: source.sourceSha256,
      tracking: tracking?.value || null,
      releaseCommit: process.env.BLOCKER_RESOLUTION_COMMIT,
      target
    })
    console.log(JSON.stringify({ filePath: source.filePath, trackingFilePath: tracking?.filePath || null, trackingSourceSha256: tracking?.sourceSha256 || null, ...report }, null, 2))
    process.exitCode = report.status === 'failed' ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      trackingStatus: 'incomplete',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'release_blocker_resolution_tracking_only'
    }, null, 2))
    process.exitCode = 1
  }
}
