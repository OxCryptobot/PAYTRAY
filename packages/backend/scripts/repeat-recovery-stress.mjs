import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { runStress } from './stress-recovery-sequence.mjs'

const ALLOWED_CONCURRENCIES = new Set([2, 4, 8])
const T95 = { 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262 }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  return value
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function parsePositiveInteger(name, fallback, { min, max }) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function parseTarget() {
  const raw = process.env.RECOVERY_RTO_TARGET_MS
  if (raw === undefined) return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1) throw new Error('RECOVERY_RTO_TARGET_MS must be a positive integer when supplied')
  return value
}

function parseConcurrencyLevels() {
  const raw = process.env.RECOVERY_STRESS_REPEAT_CONCURRENCIES || '2,4,8'
  const values = raw.split(',').map((value) => Number.parseInt(value.trim(), 10))
  if (values.length !== 3 || new Set(values).size !== 3 || values.some((value) => !ALLOWED_CONCURRENCIES.has(value))) {
    throw new Error('RECOVERY_STRESS_REPEAT_CONCURRENCIES must contain each of 2,4,8 exactly once')
  }
  return values
}

function summarizeMetric(values) {
  const normalized = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (normalized.length === 0) return { count: 0, min: null, max: null, mean: null, stdev: null, confidence95: null }
  const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length
  const variance = normalized.length > 1
    ? normalized.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (normalized.length - 1)
    : 0
  const stdev = Math.sqrt(variance)
  const critical = T95[normalized.length] || 1.96
  const halfWidth = normalized.length > 1 ? critical * stdev / Math.sqrt(normalized.length) : null
  return {
    count: normalized.length,
    min: Number(Math.min(...normalized).toFixed(3)),
    max: Number(Math.max(...normalized).toFixed(3)),
    mean: Number(mean.toFixed(3)),
    stdev: Number(stdev.toFixed(3)),
    confidence95: halfWidth === null ? null : {
      method: T95[normalized.length] ? 'two_sided_student_t' : 'normal_approximation',
      lower: Number((mean - halfWidth).toFixed(3)),
      upper: Number((mean + halfWidth).toFixed(3)),
      halfWidth: Number(halfWidth.toFixed(3))
    }
  }
}

function metricValues(reports, selector) {
  return reports.map(selector).filter((value) => typeof value === 'number' && Number.isFinite(value))
}

function buildLevelSummary(concurrency, reports) {
  const withinTarget = reports.map((report) => report.rto?.withinTarget).filter((value) => typeof value === 'boolean')
  return {
    concurrency,
    repetitionCount: reports.length,
    allVerified: reports.every((report) => report.status === 'verified'),
    failedSequences: reports.reduce((sum, report) => sum + (report.failedSequences || 0), 0),
    integrityFailures: reports.reduce((sum, report) => sum + (report.integrityFailures || 0), 0),
    throughputPerSecond: summarizeMetric(metricValues(reports, (report) => report.throughputPerSecond)),
    sequenceP95Ms: summarizeMetric(metricValues(reports, (report) => report.sequenceElapsedMs?.p95)),
    sequenceP99Ms: summarizeMetric(metricValues(reports, (report) => report.sequenceElapsedMs?.p99)),
    restoreP95Ms: summarizeMetric(metricValues(reports, (report) => report.phaseLatencyMs?.restore?.p95)),
    peakRssKb: summarizeMetric(metricValues(reports, (report) => report.resourceTelemetry?.memory?.peakRssKb)),
    userCpuTimeUs: summarizeMetric(metricValues(reports, (report) => report.resourceTelemetry?.totals?.userCpuTimeUs)),
    databaseTempBytes: summarizeMetric(metricValues(reports, (report) => report.databaseTelemetry?.temporaryStorage?.tempBytesDelta)),
    connectionAcquisitionP95Ms: summarizeMetric(metricValues(reports, (report) => report.databaseTelemetry?.connectionAcquisitionMs?.max)),
    rto: {
      targetMs: reports[0]?.rto?.targetMs ?? null,
      targetConfigured: reports[0]?.rto?.targetConfigured === true,
      withinTargetCount: withinTarget.filter(Boolean).length,
      evaluatedRuns: withinTarget.length,
      withinTargetRate: withinTarget.length ? Number((withinTarget.filter(Boolean).length / withinTarget.length).toFixed(3)) : null
    }
  }
}

export function buildRepeatedStressReport({ commit, repetitions, concurrencyLevels, targetMs = null, restoreJobs = null, runResults }) {
  const levels = concurrencyLevels.map((concurrency) => buildLevelSummary(
    concurrency,
    runResults.filter((result) => result.concurrency === concurrency).map((result) => result.report)
  ))
  const allVerified = levels.every((level) => level.allVerified && level.repetitionCount === repetitions && level.failedSequences === 0 && level.integrityFailures === 0)
  const report = {
    reportKind: 'local_disposable_recovery_repetition_baseline',
    status: allVerified ? 'verified' : 'blocked',
    releaseCommit: commit,
    environment: 'local_disposable',
    repetitions,
    concurrencyLevels,
    targetMs,
    restoreJobs,
    levels,
    runCount: runResults.length,
    runResults: runResults.map(({ concurrency, repetition, report: result }) => ({
      concurrency,
      repetition,
      status: result.status,
      sequenceElapsedMs: result.sequenceElapsedMs,
      throughputPerSecond: result.throughputPerSecond,
      failedSequences: result.failedSequences,
      integrityFailures: result.integrityFailures,
      databaseTelemetry: result.databaseTelemetry || null
    })),
    confidenceInterpretation: 'Confidence intervals are engineering variance evidence only; they do not establish production SLOs, release authority, settlement authority, or target-environment clearance.',
    safety: {
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }
  }
  return { ...report, fingerprint: fingerprint(report) }
}

export async function runRepeatedStress({ adminUrl, commit, repetitions, concurrencyLevels, targetMs = null, restoreJobs = null }) {
  const runResults = []
  outer: for (const concurrency of concurrencyLevels) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const report = await runStress({ adminUrl, concurrency, commit, targetMs, restoreJobs })
      runResults.push({ concurrency, repetition, report })
      if (report.status !== 'verified' || report.failedSequences > 0 || report.integrityFailures > 0) break outer
    }
  }
  return buildRepeatedStressReport({ commit, repetitions, concurrencyLevels, targetMs, restoreJobs, runResults })
}

export async function main() {
  if (process.env.RECOVERY_STRESS_ENVIRONMENT !== 'local_disposable') throw new Error('RECOVERY_STRESS_ENVIRONMENT=local_disposable is required')
  const commit = process.env.RECOVERY_STRESS_RELEASE_COMMIT
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('RECOVERY_STRESS_RELEASE_COMMIT must be 40 lowercase hexadecimal characters')
  const repetitions = parsePositiveInteger('RECOVERY_STRESS_REPETITIONS', 3, { min: 2, max: 10 })
  const concurrencyLevels = parseConcurrencyLevels()
  const targetMs = parseTarget()
  const restoreJobsRaw = process.env.RECOVERY_RESTORE_JOBS
  const restoreJobs = restoreJobsRaw === undefined ? null : Number.parseInt(restoreJobsRaw, 10)
  if (restoreJobs !== null && (!Number.isInteger(restoreJobs) || restoreJobs < 1 || restoreJobs > 4)) throw new Error('RECOVERY_RESTORE_JOBS must be an integer between 1 and 4')
  if (restoreJobs !== null && process.env.RECOVERY_RESTORE_EXPERIMENT !== 'local_disposable') throw new Error('RECOVERY_RESTORE_EXPERIMENT=local_disposable is required for restore jobs')
  const report = await runRepeatedStress({
    adminUrl: process.env.RECOVERY_STRESS_ADMIN_URL,
    commit,
    repetitions,
    concurrencyLevels,
    targetMs,
    restoreJobs
  })
  const serialized = JSON.stringify(report, null, 2)
  if (process.env.RECOVERY_STRESS_REPEAT_REPORT_FILE) {
    await fs.writeFile(process.env.RECOVERY_STRESS_REPEAT_REPORT_FILE, `${serialized}\n`, { mode: 0o600 })
  }
  console.log(serialized)
  if (report.status !== 'verified') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'local_disposable_recovery_repetition_baseline',
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
