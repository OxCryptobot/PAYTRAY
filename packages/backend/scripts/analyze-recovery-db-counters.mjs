import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const REQUIRED_CONCURRENCIES = [2, 4, 8]
const COUNTERS = ['walRecords', 'walFpi', 'walBytes', 'walBuffersFull', 'walWrite', 'walSync', 'walWriteTimeMs', 'walSyncTimeMs']
const IO_COUNTERS = ['ioReads', 'ioWrites', 'ioWriteTimeMs', 'ioFsyncs', 'ioFsyncTimeMs', 'ioExtends', 'ioExtendTimeMs']
const PHASE_BOUND_WAL_FIELDS = ['walRecords', 'walBytes', 'walWriteCalls', 'walSyncCalls', 'walWriteTimeMs', 'walSyncTimeMs']
const PHASE_BOUND_IO_FIELDS = ['ioWriteCalls', 'ioWriteTimeMs', 'ioFsyncs', 'ioFsyncTimeMs', 'ioExtendCalls', 'ioExtendTimeMs']
const PHASE_BOUND_RATE_FIELDS = ['walWriteCalls', 'walSyncCalls', 'walWriteTimeMs', 'walSyncTimeMs', 'ioWriteCalls', 'ioFsyncs', 'ioWriteTimeMs', 'ioFsyncTimeMs']

function fail(message) { throw new Error(message) }
function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}
function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`)
}
function assertNonnegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} must be a nonnegative number`)
}
function round(value, places = 3) { return Number(value.toFixed(places)) }

async function loadReport(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const jsonStart = raw.indexOf('\n{')
  const json = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw
  try { return JSON.parse(json) } catch (error) { fail(`${filePath} is not valid JSON: ${error.message}`) }
}

function readCounterBlock(block, keys, label) {
  assertObject(block, label)
  if (block.basis !== label) fail(`${label}.basis is invalid`)
  assertObject(block.deltas, `${label}.deltas`)
  return Object.fromEntries(keys.map((key) => {
    assertNonnegativeNumber(block.deltas[key], `${label}.deltas.${key}`)
    return [key, block.deltas[key]]
  }))
}

function readPhaseBoundTiming(block, label) {
  assertObject(block, label)
  if (block.basis !== 'phase_bound_postgresql_write_sync_timing' || block.phase !== 'restore') fail(`${label} basis or phase is invalid`)
  if (!['first_and_last_pg_stat_snapshot', 'worker_summary_aggregation'].includes(block.boundary)) fail(`${label}.boundary is invalid`)
  assertNonnegativeInteger(block.sampleCount, `${label}.sampleCount`)
  assertNonnegativeNumber(block.elapsedMs, `${label}.elapsedMs`)
  assertObject(block.wal, `${label}.wal`)
  assertObject(block.io, `${label}.io`)
  for (const field of PHASE_BOUND_WAL_FIELDS) assertNonnegativeNumber(block.wal[field], `${label}.wal.${field}`)
  for (const field of PHASE_BOUND_IO_FIELDS) assertNonnegativeNumber(block.io[field], `${label}.io.${field}`)
  assertObject(block.ratesPerSecond, `${label}.ratesPerSecond`)
  for (const field of PHASE_BOUND_RATE_FIELDS) {
    if (block.ratesPerSecond[field] !== null) assertNonnegativeNumber(block.ratesPerSecond[field], `${label}.ratesPerSecond.${field}`)
  }
  if (block.interpretation !== 'diagnostic_phase_bound_counter_timing_not_physical_fsync_proof') fail(`${label}.interpretation is invalid`)
  return block
}

function readDurationSummary(summary, label) {
  assertObject(summary, label)
  for (const key of ['count', 'p50', 'p95', 'p99', 'max', 'mean']) {
    assertNonnegativeNumber(summary[key], `${label}.${key}`)
  }
  assertNonnegativeInteger(summary.count, `${label}.count`)
  return Object.fromEntries(['count', 'p50', 'p95', 'p99', 'max', 'mean'].map((key) => [key, summary[key]]))
}

function summarizeWaits(telemetry) {
  const observations = telemetry.waitEvents.observations || []
  if (!Array.isArray(observations)) fail('databaseTelemetry.waitEvents.observations must be an array')
  const grouped = new Map()
  for (const event of observations) {
    assertObject(event, 'waitEvent')
    for (const key of ['waitEventType', 'waitEvent', 'state']) {
      if (typeof event[key] !== 'string' || event[key].length === 0 || event[key].length > 100 || /[\u0000-\u001f\u007f]/.test(event[key])) fail(`waitEvent.${key} is invalid`)
    }
    assertNonnegativeInteger(event.observations, 'waitEvent.observations')
    assertNonnegativeInteger(event.observedBackendCount, 'waitEvent.observedBackendCount')
    const key = `${event.waitEventType}/${event.waitEvent}/${event.state}`
    const current = grouped.get(key) || { waitEventType: event.waitEventType, waitEvent: event.waitEvent, state: event.state, observations: 0, observedBackendCount: 0 }
    current.observations += event.observations
    current.observedBackendCount = Math.max(current.observedBackendCount, event.observedBackendCount)
    grouped.set(key, current)
  }
  return [...grouped.values()].sort((a, b) => b.observations - a.observations || `${a.waitEventType}/${a.waitEvent}/${a.state}`.localeCompare(`${b.waitEventType}/${b.waitEvent}/${b.state}`))
}

function validateReport(report, expectedCommit, expectedConcurrency) {
  assertObject(report, `concurrency ${expectedConcurrency}`)
  if (report.reportKind !== 'local_disposable_recovery_stress') fail(`concurrency ${expectedConcurrency}.reportKind is invalid`)
  if (report.releaseCommit !== expectedCommit) fail(`concurrency ${expectedConcurrency} is bound to an unexpected commit`)
  if (report.environment !== 'local_disposable') fail(`concurrency ${expectedConcurrency}.environment must be local_disposable`)
  if (report.status !== 'verified' || report.failedSequences !== 0 || report.integrityFailures !== 0) fail(`concurrency ${expectedConcurrency} is not a verified zero-failure report`)
  if (report.concurrency !== expectedConcurrency || report.completedSequences !== expectedConcurrency) fail(`concurrency ${expectedConcurrency} does not have complete sequence coverage`)
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail(`concurrency ${expectedConcurrency} has unsafe authority fields`)
  if (report.rto?.targetConfigured !== false || report.rto?.withinTarget !== null) fail(`concurrency ${expectedConcurrency} must use null-target RTO semantics`)
  assertObject(report.databaseTelemetry, `concurrency ${expectedConcurrency}.databaseTelemetry`)
  const telemetry = report.databaseTelemetry
  if (telemetry.basis !== 'postgresql_observability') fail(`concurrency ${expectedConcurrency}.databaseTelemetry.basis is invalid`)
  assertNonnegativeInteger(telemetry.sampleCount, `concurrency ${expectedConcurrency}.databaseTelemetry.sampleCount`)
  const waits = summarizeWaits(telemetry)
  const wal = readCounterBlock(telemetry.wal, COUNTERS, 'pg_stat_wal')
  const io = readCounterBlock(telemetry.io, IO_COUNTERS, 'pg_stat_io')
  const phaseBoundWriteSyncTiming = readPhaseBoundTiming(telemetry.phaseBoundWriteSyncTiming, `concurrency ${expectedConcurrency}.phaseBoundWriteSyncTiming`)
  const snapshotQuery = readDurationSummary(telemetry.snapshotQueryElapsedMs, `concurrency ${expectedConcurrency}.snapshotQueryElapsedMs`)
  assertNonnegativeNumber(report.orchestrationElapsedMs, `concurrency ${expectedConcurrency}.orchestrationElapsedMs`)
  if (report.orchestrationElapsedMs <= 0) fail(`concurrency ${expectedConcurrency}.orchestrationElapsedMs must be positive`)
  const throughput = round(report.completedSequences / (report.orchestrationElapsedMs / 1000))
  const waitTotals = Object.fromEntries(waits.map((event) => [`${event.waitEventType}/${event.waitEvent}`, event.observations]))
  return {
    concurrency: expectedConcurrency,
    completedSequences: report.completedSequences,
    orchestrationElapsedMs: report.orchestrationElapsedMs,
    derivedThroughputPerSecond: throughput,
    sequenceP95Ms: report.sequenceElapsedMs?.p95 ?? report.phaseLatencyMs?.sequence?.p95 ?? null,
    restoreP95Ms: report.phaseLatencyMs?.restore?.p95 ?? null,
    sampleCount: telemetry.sampleCount,
    waitEvents: waits.slice(0, 20),
    waitTotals,
    wal,
    io,
    phaseBoundWriteSyncTiming,
    snapshotQuery
  }
}

export async function analyzeRecoveryDbCounters({ reportPaths, expectedCommit, expectedConcurrencies = REQUIRED_CONCURRENCIES } = {}) {
  if (!Array.isArray(reportPaths) || reportPaths.length !== expectedConcurrencies.length) fail('reportPaths must contain one report per expected concurrency')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  const reports = await Promise.all(reportPaths.map((filePath) => loadReport(path.resolve(filePath))))
  const levels = reports.map((report, index) => validateReport(report, expectedCommit, expectedConcurrencies[index]))
  const actual = levels.map((level) => level.concurrency).sort((a, b) => a - b)
  const expected = [...expectedConcurrencies].sort((a, b) => a - b)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('expected concurrency levels are not unique and complete')
  const content = {
    expectedCommit,
    expectedConcurrencies: expected,
    levels,
    interpretation: {
      status: 'descriptive_only',
      causalInference: false,
      transactionThroughputMeasured: false,
      fsyncZeroMeaning: 'observed_zero_is_not_proof_of_absent_physical_fsync_cost',
      note: 'WAL and pg_stat_io counters describe disposable recovery work. They are not application TPS, causal proof, production SLO evidence, RTO clearance, release authority, or settlement authority.'
    }
  }
  return {
    reportKind: 'local_disposable_recovery_database_counter_analysis',
    status: 'verified',
    environment: 'local_disposable',
    ...content,
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_recovery_database_counter_analysis_v1', content }),
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
  const report = await analyzeRecoveryDbCounters({ reportPaths, expectedCommit: process.env.RECOVERY_STRESS_EXPECTED_COMMIT, expectedConcurrencies })
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main() } catch (error) {
    console.error(JSON.stringify({ reportKind: 'local_disposable_recovery_database_counter_analysis', status: 'blocked', reason: error.message, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }, null, 2))
    process.exitCode = 1
  }
}
