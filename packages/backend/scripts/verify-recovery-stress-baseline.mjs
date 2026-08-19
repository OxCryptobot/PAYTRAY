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

function validateReport(report, expectedCommit, expectedConcurrency) {
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
  if (report.rto.targetConfigured !== false || report.rto.withinTarget !== null || report.rto.basis !== 'not_configured') fail(`concurrency ${expectedConcurrency} must preserve null RTO semantics without an operator target`)
  if (report.releaseEligible !== false || report.settlementAuthority !== false || report.mutation !== 'read_only' || report.deploymentPerformed !== false || report.settlementMutationPerformed !== false) fail(`concurrency ${expectedConcurrency} has unsafe authority fields`)
  const resource = validateResource(report.resourceTelemetry, `concurrency ${expectedConcurrency}.resourceTelemetry`, expectedConcurrency, report.workers)
  return {
    concurrency: expectedConcurrency,
    orchestrationElapsedMs: report.orchestrationElapsedMs,
    throughputPerSecond: report.throughputPerSecond,
    sequenceElapsedMs: report.sequenceElapsedMs,
    phaseLatencyMs: report.phaseLatencyMs,
    resource
  }
}

export async function validateRecoveryStressBaseline({ reportPaths, expectedCommit, expectedConcurrencies = REQUIRED_CONCURRENCIES } = {}) {
  if (!Array.isArray(reportPaths) || reportPaths.length !== expectedConcurrencies.length) fail('reportPaths must contain one report per expected concurrency')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) fail('expectedCommit must be a lowercase 40-character hexadecimal commit')
  const reports = await Promise.all(reportPaths.map((filePath) => loadReport(path.resolve(filePath))))
  const levels = reports.map((report, index) => validateReport(report, expectedCommit, expectedConcurrencies[index]))
  const actual = levels.map((level) => level.concurrency).sort((a, b) => a - b)
  const expected = [...expectedConcurrencies].sort((a, b) => a - b)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('expected concurrency levels are not unique and complete')
  const resourceTelemetry = levels.every((level) => level.resource.present)
  const resourceLevels = levels.filter((level) => level.resource.present).map((level) => ({ concurrency: level.concurrency, peakRssKb: level.resource.peakRssKb, maxHeapUsedBytes: level.resource.maxHeapUsedBytes }))
  const content = { expectedCommit, expectedConcurrencies: expected, levels, resourceTelemetry, resourceLevels }
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
  const report = await validateRecoveryStressBaseline({
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
