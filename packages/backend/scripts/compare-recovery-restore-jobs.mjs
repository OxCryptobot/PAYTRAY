import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const DEFAULT_JOB_LABELS = ['serial', '1', '2', '4']
const ALLOWED_JOB_VALUES = new Set(['serial', '1', '2', '4'])

function fail(message) {
  throw new Error(message)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertNonnegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} must be a nonnegative number`)
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`)
}

function assertDurationSummary(summary, label) {
  assertObject(summary, label)
  assertNonnegativeInteger(summary.count, `${label}.count`)
  for (const key of ['p50', 'p95', 'p99', 'max', 'mean']) assertNonnegativeNumber(summary[key], `${label}.${key}`)
}

function parseExpectedConcurrency(raw) {
  const value = raw === undefined ? 8 : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 2 || value > 8) fail('expectedConcurrency must be an integer between 2 and 8')
  return value
}

function normalizeJobLabel(value) {
  const label = String(value).trim().toLowerCase()
  if (!ALLOWED_JOB_VALUES.has(label)) fail(`restore-jobs label ${label} is not one of serial,1,2,4`)
  return label
}

function parseJobLabels(raw) {
  const labels = (raw === undefined ? DEFAULT_JOB_LABELS : String(raw).split(',')).map(normalizeJobLabel)
  if (labels.length !== 4 || new Set(labels).size !== 4 || labels[0] !== 'serial') fail('job labels must be serial,1,2,4 exactly once and serial must be first')
  return labels
}

function parseReportPaths(raw, expectedLength = 4) {
  const paths = String(raw || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (paths.length !== expectedLength) fail(`reportPaths must contain exactly ${expectedLength} reports`)
  return paths
}

async function loadJson(filePath) {
  const resolved = path.resolve(filePath)
  let raw
  try {
    raw = await fs.readFile(resolved, 'utf8')
  } catch (error) {
    fail(`${resolved} could not be read: ${error.message}`)
  }
  const jsonStart = raw.indexOf('\n{')
  const json = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw
  try {
    return JSON.parse(json)
  } catch (error) {
    fail(`${resolved} is not valid JSON: ${error.message}`)
  }
}

function validateSafety(report, label) {
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) {
    fail(`${label} has unsafe authority fields`)
  }
}

function validateReport(report, { expectedCommit, expectedConcurrency, jobLabel }) {
  const label = `restore jobs ${jobLabel}`
  assertObject(report, label)
  if (report.reportKind !== 'local_disposable_recovery_stress') fail(`${label}.reportKind is invalid`)
  if (report.releaseCommit !== expectedCommit) fail(`${label} is bound to an unexpected commit`)
  if (report.environment !== 'local_disposable') fail(`${label}.environment must be local_disposable`)
  if (report.status !== 'verified' || report.failedSequences !== 0 || report.integrityFailures !== 0) fail(`${label} is not a verified zero-failure report`)
  if (report.concurrency !== expectedConcurrency || report.completedSequences !== expectedConcurrency || report.requestedSequences !== expectedConcurrency) fail(`${label} does not have complete c${expectedConcurrency} coverage`)
  const expectedRestoreJobs = jobLabel === 'serial' ? null : Number(jobLabel)
  if (report.restoreJobs !== expectedRestoreJobs) fail(`${label}.restoreJobs does not match the requested setting`)
  validateSafety(report, label)
  if (report.rto?.targetConfigured !== false || report.rto?.targetMs !== null || report.rto?.withinTarget !== null) fail(`${label} must preserve null-target RTO semantics`)
  assertNonnegativeNumber(report.throughputPerSecond, `${label}.throughputPerSecond`)
  assertDurationSummary(report.sequenceElapsedMs, `${label}.sequenceElapsedMs`)
  assertObject(report.phaseLatencyMs, `${label}.phaseLatencyMs`)
  assertDurationSummary(report.phaseLatencyMs.restore, `${label}.phaseLatencyMs.restore`)
  assertObject(report.childProcessTelemetry, `${label}.childProcessTelemetry`)
  if (report.childProcessTelemetry.basis !== 'procfs_child_process') fail(`${label}.childProcessTelemetry.basis is invalid`)
  for (const field of ['elapsedMs', 'userCpuTimeMs', 'systemCpuTimeMs', 'peakRssKb']) assertNonnegativeNumber(report.childProcessTelemetry[field], `${label}.childProcessTelemetry.${field}`)
  assertObject(report.databaseTelemetry, `${label}.databaseTelemetry`)
  if (report.databaseTelemetry.basis !== 'postgresql_observability') fail(`${label}.databaseTelemetry.basis is invalid`)
  assertNonnegativeInteger(report.databaseTelemetry.sampleCount, `${label}.databaseTelemetry.sampleCount`)
  assertObject(report.databaseTelemetry.connectionAcquisitionMs, `${label}.databaseTelemetry.connectionAcquisitionMs`)
  assertNonnegativeNumber(report.databaseTelemetry.connectionAcquisitionMs.max, `${label}.databaseTelemetry.connectionAcquisitionMs.max`)
  assertObject(report.databaseTelemetry.poolPressure, `${label}.databaseTelemetry.poolPressure`)
  assertNonnegativeNumber(report.databaseTelemetry.poolPressure.maxWaitingCount, `${label}.databaseTelemetry.poolPressure.maxWaitingCount`)
  assertNonnegativeNumber(report.databaseTelemetry.poolPressure.maxUtilizationRatio, `${label}.databaseTelemetry.poolPressure.maxUtilizationRatio`)
  return {
    jobLabel,
    restoreJobs: expectedRestoreJobs,
    restoreP95Ms: report.phaseLatencyMs.restore.p95,
    sequenceP95Ms: report.sequenceElapsedMs.p95,
    throughputPerSecond: report.throughputPerSecond,
    connectionAcquisitionP95Ms: report.databaseTelemetry.connectionAcquisitionMs.max,
    childRestoreElapsedMs: report.childProcessTelemetry.elapsedMs,
    childUserCpuTimeMs: report.childProcessTelemetry.userCpuTimeMs,
    childSystemCpuTimeMs: report.childProcessTelemetry.systemCpuTimeMs,
    childPeakRssKb: report.childProcessTelemetry.peakRssKb,
    poolMaxWaitingCount: report.databaseTelemetry.poolPressure.maxWaitingCount,
    poolMaxUtilizationRatio: report.databaseTelemetry.poolPressure.maxUtilizationRatio
  }
}

function percentDelta(value, baseline) {
  if (baseline === 0) return null
  return Number((((value / baseline) - 1) * 100).toFixed(3))
}

export async function compareRecoveryRestoreJobs({ reportPaths, expectedCommit, expectedConcurrency = 8, jobLabels = DEFAULT_JOB_LABELS } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  if (!Array.isArray(reportPaths) || reportPaths.length !== 4) fail('reportPaths must contain exactly four reports')
  if (!Array.isArray(jobLabels) || jobLabels.length !== 4) fail('jobLabels must contain exactly four labels')
  const normalizedLabels = jobLabels.map(normalizeJobLabel)
  if (new Set(normalizedLabels).size !== 4 || normalizedLabels[0] !== 'serial') fail('jobLabels must be serial,1,2,4 exactly once and serial must be first')
  const reports = await Promise.all(reportPaths.map((reportPath) => loadJson(reportPath)))
  const levels = reports.map((report, index) => validateReport(report, { expectedCommit, expectedConcurrency, jobLabel: normalizedLabels[index] }))
  const serial = levels[0]
  const bounded = levels.slice(1)
  const comparisons = bounded.map((level) => ({
    ...level,
    deltaVsSerial: {
      restoreP95Ms: Number((level.restoreP95Ms - serial.restoreP95Ms).toFixed(3)),
      restoreP95Percent: percentDelta(level.restoreP95Ms, serial.restoreP95Ms),
      sequenceP95Ms: Number((level.sequenceP95Ms - serial.sequenceP95Ms).toFixed(3)),
      sequenceP95Percent: percentDelta(level.sequenceP95Ms, serial.sequenceP95Ms),
      throughputPerSecond: Number((level.throughputPerSecond - serial.throughputPerSecond).toFixed(3)),
      throughputPercent: percentDelta(level.throughputPerSecond, serial.throughputPerSecond),
      connectionAcquisitionP95Ms: Number((level.connectionAcquisitionP95Ms - serial.connectionAcquisitionP95Ms).toFixed(3)),
      connectionAcquisitionP95Percent: percentDelta(level.connectionAcquisitionP95Ms, serial.connectionAcquisitionP95Ms),
      childRestoreElapsedMs: Number((level.childRestoreElapsedMs - serial.childRestoreElapsedMs).toFixed(3)),
      childRestoreElapsedPercent: percentDelta(level.childRestoreElapsedMs, serial.childRestoreElapsedMs)
    },
    restoreP95ImprovesOnSerial: level.restoreP95Ms < serial.restoreP95Ms
  }))
  const best = [...levels].sort((left, right) => left.restoreP95Ms - right.restoreP95Ms)[0]
  const anyBoundedImprovement = comparisons.some((comparison) => comparison.restoreP95ImprovesOnSerial)
  const content = {
    expectedCommit,
    expectedConcurrency,
    jobLabels: normalizedLabels,
    serialBaseline: serial,
    boundedComparisons: comparisons,
    bestObservedSetting: best.jobLabel,
    conclusion: anyBoundedImprovement ? 'follow_up_required_before_any_default_change' : 'retain_serial_baseline',
    interpretation: {
      status: 'descriptive_only',
      experiment: 'local_disposable_restore_jobs_comparison',
      defaultChangeAuthorized: false,
      productionCapacityMeasured: false,
      productionRtoMeasured: false,
      causalInference: false,
      note: 'A single bounded disposable comparison can identify a follow-up candidate but cannot change production restore defaults, establish an RTO/SLO, or grant target/release/settlement authority.'
    }
  }
  return {
    reportKind: 'local_disposable_recovery_restore_jobs_comparison',
    status: 'verified',
    environment: 'local_disposable',
    ...content,
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_recovery_restore_jobs_comparison_v1', content }),
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function main() {
  const reportPaths = parseReportPaths(process.env.RECOVERY_RESTORE_JOBS_REPORTS)
  const expectedCommit = process.env.RECOVERY_RESTORE_JOBS_EXPECTED_COMMIT
  const expectedConcurrency = parseExpectedConcurrency(process.env.RECOVERY_RESTORE_JOBS_EXPECTED_CONCURRENCY)
  const jobLabels = parseJobLabels(process.env.RECOVERY_RESTORE_JOBS_LABELS)
  const report = await compareRecoveryRestoreJobs({ reportPaths, expectedCommit, expectedConcurrency, jobLabels })
  if (process.env.RECOVERY_RESTORE_JOBS_OUTPUT_PATH) await fs.writeFile(process.env.RECOVERY_RESTORE_JOBS_OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'local_disposable_recovery_restore_jobs_comparison',
      status: 'blocked',
      reason: error.message,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    process.exitCode = 1
  }
}
