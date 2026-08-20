import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const REQUIRED_CONCURRENCIES = [2, 4, 8]
const MAX_LABEL_LENGTH = 80

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

function assertLabel(value, label) {
  const hasControlCharacter = typeof value === 'string' && [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH || hasControlCharacter) fail(`${label} is invalid`)
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(3))
}

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null, mean: null }
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
  }
}

async function loadReport(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const jsonStart = raw.indexOf('\n{')
  const json = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw
  try {
    return JSON.parse(json)
  } catch (error) {
    fail(`${filePath} does not contain a recovery stress JSON report: ${error.message}`)
  }
}

function validateWaitEvent(event, label) {
  assertObject(event, label)
  for (const field of ['waitEventType', 'waitEvent', 'state']) assertLabel(event[field], `${label}.${field}`)
  assertNonnegativeInteger(event.observations, `${label}.observations`)
  assertNonnegativeInteger(event.observedBackendCount, `${label}.observedBackendCount`)
}

function validateWorker(worker, expectedConcurrency, index) {
  const label = `concurrency ${expectedConcurrency}.workers[${index}]`
  assertObject(worker, label)
  if (worker.status !== 'verified') fail(`${label}.status must be verified`)
  assertObject(worker.databaseTelemetry, `${label}.databaseTelemetry`)
  if (worker.databaseTelemetry.basis !== 'postgresql_observability') fail(`${label}.databaseTelemetry.basis is invalid`)
  assertNonnegativeInteger(worker.databaseTelemetry.sampleCount, `${label}.databaseTelemetry.sampleCount`)
  assertObject(worker.databaseTelemetry.connectionAcquisitionMs, `${label}.databaseTelemetry.connectionAcquisitionMs`)
  for (const field of ['count']) assertNonnegativeInteger(worker.databaseTelemetry.connectionAcquisitionMs[field], `${label}.databaseTelemetry.connectionAcquisitionMs.${field}`)
  for (const field of ['p50', 'p95', 'p99', 'max', 'mean']) assertNonnegativeNumber(worker.databaseTelemetry.connectionAcquisitionMs[field], `${label}.databaseTelemetry.connectionAcquisitionMs.${field}`)
  assertObject(worker.databaseTelemetry.waitEvents, `${label}.databaseTelemetry.waitEvents`)
  if (!Array.isArray(worker.databaseTelemetry.waitEvents.observations)) fail(`${label}.databaseTelemetry.waitEvents.observations must be an array`)
  worker.databaseTelemetry.waitEvents.observations.forEach((event, eventIndex) => validateWaitEvent(event, `${label}.databaseTelemetry.waitEvents.observations[${eventIndex}]`))
  assertObject(worker.databaseTelemetry.temporaryStorage, `${label}.databaseTelemetry.temporaryStorage`)
  for (const field of ['tempBytesDelta', 'tempFilesDelta']) assertNonnegativeInteger(worker.databaseTelemetry.temporaryStorage[field], `${label}.databaseTelemetry.temporaryStorage.${field}`)
  assertObject(worker.storageTelemetry, `${label}.storageTelemetry`)
  if (worker.storageTelemetry.basis !== 'local_disposable_backup_file') fail(`${label}.storageTelemetry.basis is invalid`)
  for (const field of ['backupBytes']) assertNonnegativeInteger(worker.storageTelemetry[field], `${label}.storageTelemetry.${field}`)
  for (const field of ['backupDurationMs', 'backupWriteThroughputBytesPerSecond']) assertNonnegativeNumber(worker.storageTelemetry[field], `${label}.storageTelemetry.${field}`)
  return worker
}

function aggregateWaitEvents(workers) {
  const byKey = new Map()
  for (const worker of workers) {
    for (const event of worker.databaseTelemetry.waitEvents.observations) {
      const key = JSON.stringify([event.waitEventType, event.waitEvent, event.state])
      const current = byKey.get(key) || {
        waitEventType: event.waitEventType,
        waitEvent: event.waitEvent,
        state: event.state,
        observations: 0,
        observedBackendCount: 0,
        workersObserved: 0
      }
      current.observations += event.observations
      current.observedBackendCount += event.observedBackendCount
      current.workersObserved += 1
      byKey.set(key, current)
    }
  }
  return [...byKey.values()].sort((a, b) => b.observedBackendCount - a.observedBackendCount || a.waitEvent.localeCompare(b.waitEvent))
}

function aggregateLevel(report, expectedConcurrency) {
  assertObject(report, `recovery-stress-${expectedConcurrency}`)
  if (report.reportKind !== 'local_disposable_recovery_stress') fail(`concurrency ${expectedConcurrency}.reportKind is invalid`)
  if (report.environment !== 'local_disposable') fail(`concurrency ${expectedConcurrency}.environment must be local_disposable`)
  if (report.concurrency !== expectedConcurrency) fail(`concurrency ${expectedConcurrency}.concurrency is invalid`)
  if (report.status !== 'verified' || report.failedSequences !== 0 || report.integrityFailures !== 0) fail(`concurrency ${expectedConcurrency} is not a verified zero-failure report`)
  if (report.requestedSequences !== expectedConcurrency || report.completedSequences !== expectedConcurrency) fail(`concurrency ${expectedConcurrency} does not have complete worker coverage`)
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail(`concurrency ${expectedConcurrency} has unsafe authority fields`)
  if (report.rto?.targetConfigured !== false || report.rto?.withinTarget !== null) fail(`concurrency ${expectedConcurrency} must use null-target RTO semantics for comparison`)
  assertObject(report.databaseTelemetry, `concurrency ${expectedConcurrency}.databaseTelemetry`)
  if (report.databaseTelemetry.basis !== 'postgresql_observability') fail(`concurrency ${expectedConcurrency}.databaseTelemetry.basis is invalid`)
  if (report.databaseTelemetry.workerCount !== expectedConcurrency) fail(`concurrency ${expectedConcurrency}.databaseTelemetry.workerCount is invalid`)
  assertNonnegativeInteger(report.databaseTelemetry.sampleCount, `concurrency ${expectedConcurrency}.databaseTelemetry.sampleCount`)
  if (!Array.isArray(report.workers) || report.workers.length !== expectedConcurrency) fail(`concurrency ${expectedConcurrency}.workers must contain one row per worker`)
  const workers = report.workers.map((worker, index) => validateWorker(worker, expectedConcurrency, index))
  const connectionMaxima = workers.map((worker) => worker.databaseTelemetry.connectionAcquisitionMs.max)
  const temporaryBytes = workers.map((worker) => worker.databaseTelemetry.temporaryStorage.tempBytesDelta)
  const temporaryFiles = workers.map((worker) => worker.databaseTelemetry.temporaryStorage.tempFilesDelta)
  const recoveryDurations = workers.map((worker) => worker.recoveryElapsedMs).filter((value) => Number.isFinite(value) && value >= 0)
  return {
    concurrency: expectedConcurrency,
    workerCount: workers.length,
    sampleCount: report.databaseTelemetry.sampleCount,
    waitEvents: aggregateWaitEvents(workers),
    connectionAcquisitionMaxMs: summarize(connectionMaxima),
    temporaryStorage: {
      tempBytesDeltaTotal: temporaryBytes.reduce((sum, value) => sum + value, 0),
      tempFilesDeltaTotal: temporaryFiles.reduce((sum, value) => sum + value, 0),
      workersWithTempBytes: temporaryBytes.filter((value) => value > 0).length,
      workersWithTempFiles: temporaryFiles.filter((value) => value > 0).length
    },
    recoveryElapsedMs: summarize(recoveryDurations)
  }
}

export async function aggregateRecoveryWaitEvents({ reportPaths, expectedCommit, expectedConcurrencies = REQUIRED_CONCURRENCIES } = {}) {
  if (!Array.isArray(reportPaths) || reportPaths.length !== expectedConcurrencies.length) fail('reportPaths must contain one report per expected concurrency')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  const reports = await Promise.all(reportPaths.map((filePath) => loadReport(path.resolve(filePath))))
  for (const report of reports) if (report.releaseCommit !== expectedCommit) fail('all reports must bind to expectedCommit')
  const levels = reports.map((report, index) => aggregateLevel(report, expectedConcurrencies[index]))
  const actual = levels.map((level) => level.concurrency).sort((a, b) => a - b)
  const expected = [...expectedConcurrencies].sort((a, b) => a - b)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('expected concurrency levels are not unique and complete')
  const content = { expectedCommit, expectedConcurrencies: expected, levels }
  return {
    reportKind: 'local_disposable_recovery_wait_event_distribution',
    status: 'verified',
    environment: 'local_disposable',
    ...content,
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_recovery_wait_event_distribution_v1', content }),
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
  const report = await aggregateRecoveryWaitEvents({
    reportPaths,
    expectedCommit: process.env.RECOVERY_STRESS_EXPECTED_COMMIT,
    expectedConcurrencies
  })
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'local_disposable_recovery_wait_event_distribution',
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
