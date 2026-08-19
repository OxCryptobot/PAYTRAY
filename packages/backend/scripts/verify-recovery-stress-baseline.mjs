import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const REQUIRED_CONCURRENCIES = [2, 4, 8]
const REQUIRED_PHASES = ['backup', 'backup_integrity', 'catalog', 'restore', 'restore_verification']
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

function validateDatabaseTelemetry(report, expectedConcurrency) {
  const label = `concurrency ${expectedConcurrency}.databaseTelemetry`
  assertObject(report.databaseTelemetry, label)
  if (report.databaseTelemetry.basis !== 'postgresql_observability') fail(`${label}.basis is invalid`)
  if (report.databaseTelemetry.workerCount !== expectedConcurrency) fail(`${label}.workerCount must equal concurrency ${expectedConcurrency}`)
  if (!Number.isSafeInteger(report.databaseTelemetry.sampleCount) || report.databaseTelemetry.sampleCount < expectedConcurrency * 2) fail(`${label}.sampleCount must include at least two samples per worker`)
  assertObject(report.databaseTelemetry.connectionAcquisitionMs, `${label}.connectionAcquisitionMs`)
  if (!Array.isArray(report.databaseTelemetry.connectionAcquisitionMs.perWorker) || report.databaseTelemetry.connectionAcquisitionMs.perWorker.length !== expectedConcurrency) fail(`${label}.connectionAcquisitionMs.perWorker must contain one summary per worker`)
  report.databaseTelemetry.connectionAcquisitionMs.perWorker.forEach((summary, index) => {
    assertObject(summary, `${label}.connectionAcquisitionMs.perWorker[${index}]`)
    assertNonnegativeInteger(summary.count, `${label}.connectionAcquisitionMs.perWorker[${index}].count`)
    for (const field of ['p50', 'p95', 'p99', 'max', 'mean']) assertNonnegativeNumber(summary[field], `${label}.connectionAcquisitionMs.perWorker[${index}].${field}`)
  })
  assertNonnegativeNumber(report.databaseTelemetry.connectionAcquisitionMs.max, `${label}.connectionAcquisitionMs.max`)
  assertObject(report.databaseTelemetry.waitEvents, `${label}.waitEvents`)
  if (report.databaseTelemetry.waitEvents.sampleCount !== report.databaseTelemetry.sampleCount) fail(`${label}.waitEvents.sampleCount must equal sampleCount`)
  if (!Array.isArray(report.databaseTelemetry.waitEvents.observations) || report.databaseTelemetry.waitEvents.observations.length > expectedConcurrency * 32) fail(`${label}.waitEvents.observations exceeds bounded worker limit`)
  for (const [index, event] of report.databaseTelemetry.waitEvents.observations.entries()) {
    assertObject(event, `${label}.waitEvents.observations[${index}]`)
    for (const field of ['waitEventType', 'waitEvent', 'state']) {
      if (typeof event[field] !== 'string' || event[field].length > 80) fail(`${label}.waitEvents.observations[${index}].${field} is invalid`)
    }
    assertNonnegativeInteger(event.observations, `${label}.waitEvents.observations[${index}].observations`)
    assertNonnegativeInteger(event.observedBackendCount, `${label}.waitEvents.observations[${index}].observedBackendCount`)
  }
  assertObject(report.databaseTelemetry.temporaryStorage, `${label}.temporaryStorage`)
  for (const field of ['tempBytesDelta', 'tempFilesDelta']) assertNonnegativeInteger(report.databaseTelemetry.temporaryStorage[field], `${label}.temporaryStorage.${field}`)
  for (const field of ['operationElapsedMs', 'throughputBytesPerSecond']) assertNonnegativeNumber(report.databaseTelemetry.temporaryStorage[field], `${label}.temporaryStorage.${field}`)
  if (!Array.isArray(report.databaseTelemetry.errors) || report.databaseTelemetry.errors.length !== 0) fail(`${label}.errors must be an empty array for a verified baseline`)
  if (!Array.isArray(report.workers) || report.workers.length !== expectedConcurrency) fail(`concurrency ${expectedConcurrency}.workers must contain one worker per sequence`)
  report.workers.forEach((worker, index) => {
    assertObject(worker, `concurrency ${expectedConcurrency}.workers[${index}]`)
    assertObject(worker.databaseTelemetry, `concurrency ${expectedConcurrency}.workers[${index}].databaseTelemetry`)
    if (worker.databaseTelemetry.basis !== 'postgresql_observability') fail(`concurrency ${expectedConcurrency}.workers[${index}].databaseTelemetry.basis is invalid`)
    if (!Number.isSafeInteger(worker.databaseTelemetry.sampleCount) || worker.databaseTelemetry.sampleCount < 2) fail(`concurrency ${expectedConcurrency}.workers[${index}].databaseTelemetry.sampleCount must be at least 2`)
    assertObject(worker.storageTelemetry, `concurrency ${expectedConcurrency}.workers[${index}].storageTelemetry`)
    if (worker.storageTelemetry.basis !== 'local_disposable_backup_file') fail(`concurrency ${expectedConcurrency}.workers[${index}].storageTelemetry.basis is invalid`)
    assertNonnegativeInteger(worker.storageTelemetry.backupBytes, `concurrency ${expectedConcurrency}.workers[${index}].storageTelemetry.backupBytes`)
    assertNonnegativeNumber(worker.storageTelemetry.backupDurationMs, `concurrency ${expectedConcurrency}.workers[${index}].storageTelemetry.backupDurationMs`)
    assertNonnegativeNumber(worker.storageTelemetry.backupWriteThroughputBytesPerSecond, `concurrency ${expectedConcurrency}.workers[${index}].storageTelemetry.backupWriteThroughputBytesPerSecond`)
  })
  return {
    basis: report.databaseTelemetry.basis,
    workerCount: report.databaseTelemetry.workerCount,
    sampleCount: report.databaseTelemetry.sampleCount,
    connectionAcquisitionMaxMs: report.databaseTelemetry.connectionAcquisitionMs.max,
    waitEventCount: report.databaseTelemetry.waitEvents.observations.length,
    temporaryBytesDelta: report.databaseTelemetry.temporaryStorage.tempBytesDelta
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

function validateResource(resource, label, expectedSamples, workers = []) {
  if (resource === undefined) return { present: false }
  assertObject(resource, label)
  if (resource.basis !== 'node_process_resource_usage') fail(`${label}.basis is invalid`)
  if (resource.sampleCount !== expectedSamples) fail(`${label}.sampleCount must equal concurrency ${expectedSamples}`)
  assertObject(resource.totals, `${label}.totals`)
  for (const field of ['userCpuTimeUs', 'systemCpuTimeUs', 'fsReadOps', 'fsWriteOps', 'voluntaryContextSwitches', 'involuntaryContextSwitches']) {
    assertNonnegativeInteger(resource.totals[field], `${label}.totals.${field}`)
  }
  assertObject(resource.memory, `${label}.memory`)
  for (const field of ['peakRssKb', 'maxRssBytes', 'maxHeapUsedBytes']) assertNonnegativeInteger(resource.memory[field], `${label}.memory.${field}`)
  const perWorkerPeakRssKb = Array.isArray(resource.perWorkerPeakRssKb)
    ? resource.perWorkerPeakRssKb
    : workers.map((worker) => worker.resource?.peakRssKb).filter((value) => value !== undefined)
  if (perWorkerPeakRssKb.length !== expectedSamples) fail(`${label}.perWorkerPeakRssKb must contain one value per worker`)
  for (const [index, value] of perWorkerPeakRssKb.entries()) assertNonnegativeInteger(value, `${label}.perWorkerPeakRssKb[${index}]`)
  return { present: true, sampleCount: resource.sampleCount, peakRssKb: resource.memory.peakRssKb, maxHeapUsedBytes: resource.memory.maxHeapUsedBytes }
}

function validateReport(report, expectedCommit, expectedConcurrency, expectedRtoTargetMs = null, requireDatabaseTelemetry = false) {
  assertObject(report, `recovery-stress-${expectedConcurrency}`)
  if (report.reportKind !== 'local_disposable_recovery_stress') fail(`concurrency ${expectedConcurrency} has an invalid reportKind`)
  if (report.releaseCommit !== expectedCommit) fail(`concurrency ${expectedConcurrency} is bound to an unexpected commit`)
  if (report.environment !== 'local_disposable') fail(`concurrency ${expectedConcurrency} must use local_disposable environment`)
  if (report.concurrency !== expectedConcurrency) fail(`expected concurrency ${expectedConcurrency}, received ${report.concurrency}`)
  if (report.requestedSequences !== expectedConcurrency || report.completedSequences !== expectedConcurrency) fail(`concurrency ${expectedConcurrency} did not complete exactly one sequence per worker`)
  if (report.failedSequences !== 0 || report.integrityFailures !== 0 || report.status !== 'verified') fail(`concurrency ${expectedConcurrency} has failed or unverified recovery sequences`)
  assertObject(report.phaseLatencyMs, `concurrency ${expectedConcurrency}.phaseLatencyMs`)
  for (const phase of REQUIRED_PHASES) {
    assertObject(report.phaseLatencyMs[phase], `concurrency ${expectedConcurrency}.phaseLatencyMs.${phase}`)
    assertNonnegativeInteger(report.phaseLatencyMs[phase].count, `concurrency ${expectedConcurrency}.phaseLatencyMs.${phase}.count`)
  }
  assertObject(report.rto, `concurrency ${expectedConcurrency}.rto`)
  assertObject(report.sequenceElapsedMs, `concurrency ${expectedConcurrency}.sequenceElapsedMs`)
  if (expectedRtoTargetMs === null) {
    if (report.rto.targetConfigured !== false || report.rto.withinTarget !== null || report.rto.basis !== 'not_configured') fail(`concurrency ${expectedConcurrency} must preserve null RTO semantics without an operator target`)
  } else {
    if (report.rto.targetConfigured !== true || report.rto.targetMs !== expectedRtoTargetMs || report.rto.basis !== 'operator_supplied_target') fail(`concurrency ${expectedConcurrency} has inconsistent operator RTO target fields`)
    if (typeof report.rto.withinTarget !== 'boolean') fail(`concurrency ${expectedConcurrency}.rto.withinTarget must be boolean with an operator target`)
    if (typeof report.sequenceElapsedMs.max !== 'number' || !Number.isFinite(report.sequenceElapsedMs.max) || report.sequenceElapsedMs.max < 0) fail(`concurrency ${expectedConcurrency}.sequenceElapsedMs.max is invalid`)
    if (report.rto.withinTarget !== report.sequenceElapsedMs.max <= expectedRtoTargetMs) fail(`concurrency ${expectedConcurrency}.withinTarget is inconsistent with sequence max and target`)
  }
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail(`concurrency ${expectedConcurrency} has unsafe authority fields`)
  const resource = validateResource(report.resourceTelemetry, `concurrency ${expectedConcurrency}.resourceTelemetry`, expectedConcurrency, report.workers)
  const database = requireDatabaseTelemetry ? validateDatabaseTelemetry(report, expectedConcurrency) : null
  return {
    concurrency: expectedConcurrency,
    orchestrationElapsedMs: report.orchestrationElapsedMs,
    throughputPerSecond: report.throughputPerSecond,
    sequenceElapsedMs: report.sequenceElapsedMs,
    phaseLatencyMs: report.phaseLatencyMs,
    rto: report.rto,
    resource,
    ...(database ? { database } : {})
  }
}

export async function validateRecoveryStressBaseline({ reportPaths, expectedCommit, expectedConcurrencies = REQUIRED_CONCURRENCIES, expectedRtoTargetMs = null, requireDatabaseTelemetry = false } = {}) {
  if (!Array.isArray(reportPaths) || reportPaths.length !== expectedConcurrencies.length) fail('reportPaths must contain one report per expected concurrency')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  const reports = await Promise.all(reportPaths.map((filePath) => loadReport(path.resolve(filePath))))
  if (expectedRtoTargetMs !== null && (!Number.isSafeInteger(expectedRtoTargetMs) || expectedRtoTargetMs < 1)) fail('expectedRtoTargetMs must be a positive integer when supplied')
  const levels = reports.map((report, index) => validateReport(report, expectedCommit, expectedConcurrencies[index], expectedRtoTargetMs, requireDatabaseTelemetry))
  const actual = levels.map((level) => level.concurrency).sort((a, b) => a - b)
  const expected = [...expectedConcurrencies].sort((a, b) => a - b)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('expected concurrency levels are not unique and complete')
  const resourceTelemetry = levels.every((level) => level.resource.present)
  const resourceLevels = levels.filter((level) => level.resource.present).map((level) => ({ concurrency: level.concurrency, peakRssKb: level.resource.peakRssKb, maxHeapUsedBytes: level.resource.maxHeapUsedBytes }))
  const databaseTelemetry = levels.every((level) => level.database !== null)
  const databaseLevels = levels.filter((level) => level.database !== null).map((level) => ({ concurrency: level.concurrency, ...level.database }))
  const content = { expectedCommit, expectedConcurrencies: expected, levels, resourceTelemetry, resourceLevels, databaseTelemetry, databaseLevels }
  return {
    reportKind: 'local_disposable_recovery_stress_baseline',
    status: 'verified',
    environment: 'local_disposable',
    ...content,
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_recovery_stress_baseline_v1', content }),
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
  const expectedRtoTargetRaw = process.env.RECOVERY_STRESS_EXPECTED_RTO_TARGET_MS
  const expectedRtoTargetMs = expectedRtoTargetRaw === undefined ? null : Number.parseInt(expectedRtoTargetRaw, 10)
  const requireDatabaseTelemetry = process.env.RECOVERY_STRESS_REQUIRE_DATABASE_TELEMETRY === 'true'
  const report = await validateRecoveryStressBaseline({
    reportPaths,
    expectedCommit: process.env.RECOVERY_STRESS_EXPECTED_COMMIT,
    expectedConcurrencies,
    expectedRtoTargetMs,
    requireDatabaseTelemetry
  })
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'local_disposable_recovery_stress_baseline',
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
