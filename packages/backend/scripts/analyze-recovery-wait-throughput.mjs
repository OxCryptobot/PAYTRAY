import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const REQUIRED_CONCURRENCIES = [2, 4, 8]
const SIGNALS = [
  { key: 'dataFileImmediateSync', waitEventType: 'IO', waitEvent: 'DataFileImmediateSync' },
  { key: 'lwLockWalWrite', waitEventType: 'LWLock', waitEvent: 'WALWrite' }
]

function fail(message) {
  throw new Error(message)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`)
}

function assertNonnegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} must be a nonnegative number`)
}

async function loadReport(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const jsonStart = raw.indexOf('\n{')
  const json = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw
  try {
    return JSON.parse(json)
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`)
  }
}

function round(value, places = 3) {
  return Number(value.toFixed(places))
}

function signalObservation(report, signal) {
  return (report.databaseTelemetry.waitEvents.observations || [])
    .filter((event) => event.waitEventType === signal.waitEventType && event.waitEvent === signal.waitEvent)
    .reduce((sum, event) => sum + event.observations, 0)
}

function deriveThroughput(report, expectedConcurrency) {
  assertNonnegativeInteger(report.completedSequences, `concurrency ${expectedConcurrency}.completedSequences`)
  assertNonnegativeNumber(report.orchestrationElapsedMs, `concurrency ${expectedConcurrency}.orchestrationElapsedMs`)
  if (report.orchestrationElapsedMs <= 0) fail(`concurrency ${expectedConcurrency}.orchestrationElapsedMs must be positive`)
  const derived = report.completedSequences / (report.orchestrationElapsedMs / 1000)
  const recorded = report.throughputPerSecond
  return {
    basis: 'completed_sequences_over_orchestration_elapsed_ms',
    recordedThroughputPerSecond: typeof recorded === 'number' && Number.isFinite(recorded) ? recorded : null,
    derivedThroughputPerSecond: round(derived),
    orchestrationElapsedMs: report.orchestrationElapsedMs,
    completedSequences: report.completedSequences
  }
}

function validateReport(report, expectedCommit, expectedConcurrency) {
  assertObject(report, `concurrency ${expectedConcurrency}`)
  if (report.reportKind !== 'local_disposable_recovery_stress') fail(`concurrency ${expectedConcurrency}.reportKind is invalid`)
  if (report.releaseCommit !== expectedCommit) fail(`concurrency ${expectedConcurrency} is bound to an unexpected commit`)
  if (report.environment !== 'local_disposable') fail(`concurrency ${expectedConcurrency}.environment must be local_disposable`)
  if (report.status !== 'verified' || report.failedSequences !== 0 || report.integrityFailures !== 0) fail(`concurrency ${expectedConcurrency} is not a verified zero-failure report`)
  if (report.concurrency !== expectedConcurrency || report.requestedSequences !== expectedConcurrency || report.completedSequences !== expectedConcurrency) fail(`concurrency ${expectedConcurrency} does not have complete sequence coverage`)
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail(`concurrency ${expectedConcurrency} has unsafe authority fields`)
  if (report.rto?.targetConfigured !== false || report.rto?.withinTarget !== null) fail(`concurrency ${expectedConcurrency} must use null-target RTO semantics`)
  assertObject(report.databaseTelemetry, `concurrency ${expectedConcurrency}.databaseTelemetry`)
  if (report.databaseTelemetry.basis !== 'postgresql_observability') fail(`concurrency ${expectedConcurrency}.databaseTelemetry.basis is invalid`)
  assertNonnegativeInteger(report.databaseTelemetry.sampleCount, `concurrency ${expectedConcurrency}.databaseTelemetry.sampleCount`)
  assertObject(report.databaseTelemetry.waitEvents, `concurrency ${expectedConcurrency}.databaseTelemetry.waitEvents`)
  if (!Array.isArray(report.databaseTelemetry.waitEvents.observations)) fail(`concurrency ${expectedConcurrency}.databaseTelemetry.waitEvents.observations must be an array`)
  const throughput = deriveThroughput(report, expectedConcurrency)
  const signals = Object.fromEntries(SIGNALS.map((signal) => {
    const observations = signalObservation(report, signal)
    return [signal.key, {
      waitEventType: signal.waitEventType,
      waitEvent: signal.waitEvent,
      observations,
      ratePer100Samples: report.databaseTelemetry.sampleCount === 0 ? null : round((observations / report.databaseTelemetry.sampleCount) * 100),
      workersObserved: report.workers.filter((worker) => (worker.databaseTelemetry?.waitEvents?.observations || []).some((event) => event.waitEventType === signal.waitEventType && event.waitEvent === signal.waitEvent)).length
    }]
  }))
  return {
    concurrency: expectedConcurrency,
    throughput,
    sequenceElapsedMs: report.sequenceElapsedMs,
    restorePhase: report.phaseLatencyMs?.restore || null,
    connectionAcquisitionMaxMs: report.databaseTelemetry.connectionAcquisitionMs || null,
    sampleCount: report.databaseTelemetry.sampleCount,
    signals
  }
}

function addScalingMetrics(levels) {
  const base = levels[0].throughput.derivedThroughputPerSecond
  return levels.map((level) => {
    const expectedLinear = base * (level.concurrency / levels[0].concurrency)
    return {
      ...level,
      scaling: {
        expectedLinearThroughputPerSecond: round(expectedLinear),
        efficiencyVsLinearPercent: base === 0 ? null : round((level.throughput.derivedThroughputPerSecond / expectedLinear) * 100),
        throughputChangeVsPreviousPercent: null
      }
    }
  }).map((level, index, all) => ({
    ...level,
    scaling: {
      ...level.scaling,
      throughputChangeVsPreviousPercent: index === 0 ? null : round(((level.throughput.derivedThroughputPerSecond - all[index - 1].throughput.derivedThroughputPerSecond) / all[index - 1].throughput.derivedThroughputPerSecond) * 100)
    }
  }))
}

export async function analyzeRecoveryWaitThroughput({ reportPaths, expectedCommit, expectedConcurrencies = REQUIRED_CONCURRENCIES } = {}) {
  if (!Array.isArray(reportPaths) || reportPaths.length !== expectedConcurrencies.length) fail('reportPaths must contain one report per expected concurrency')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  const reports = await Promise.all(reportPaths.map((filePath) => loadReport(path.resolve(filePath))))
  const levels = reports.map((report, index) => validateReport(report, expectedCommit, expectedConcurrencies[index]))
  const actual = levels.map((level) => level.concurrency).sort((a, b) => a - b)
  const expected = [...expectedConcurrencies].sort((a, b) => a - b)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('expected concurrency levels are not unique and complete')
  const scaledLevels = addScalingMetrics(levels)
  const content = {
    expectedCommit,
    expectedConcurrencies: expected,
    levels: scaledLevels,
    interpretation: {
      status: 'descriptive_only',
      sampleUnit: 'pg_stat_activity_observation',
      throughputUnit: 'completed_recovery_sequences_per_second',
      causalInference: false,
      transactionThroughputMeasured: false,
      note: 'The recovery harness measures completed recovery sequences, not application transaction TPS. Wait-event rates identify diagnostic signals and are not causal proof or production SLO evidence.'
    }
  }
  return {
    reportKind: 'local_disposable_recovery_wait_throughput_analysis',
    status: 'verified',
    environment: 'local_disposable',
    ...content,
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_recovery_wait_throughput_analysis_v1', content }),
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function main() {
  const reportPaths = String(process.env.RECOVERY_STRESS_REPORTS || '').split(',').map((value) => value.trim()).filter(Boolean)
  const expectedConcurrencies = String(process.env.RECOVERY_STRESS_EXPECTED_CONCURRENCIES || '2,4,8').split(',').map((value) => Number.parseInt(value.trim(), 10))
  const report = await analyzeRecoveryWaitThroughput({ reportPaths, expectedCommit: process.env.RECOVERY_STRESS_EXPECTED_COMMIT, expectedConcurrencies })
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'local_disposable_recovery_wait_throughput_analysis',
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
