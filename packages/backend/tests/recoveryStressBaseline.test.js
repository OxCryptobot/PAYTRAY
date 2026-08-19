import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateRecoveryStressBaseline } from '../scripts/verify-recovery-stress-baseline.mjs'

const COMMIT = 'f488f6db0d77a0414c6061f7a1b3e50ca08be105'

function sampleReport(concurrency, { resource = false, unsafe = false, rtoTargetMs = null } = {}) {
  const phaseLatencyMs = Object.fromEntries(['backup', 'backup_integrity', 'catalog', 'restore', 'restore_verification'].map((phase) => [phase, { count: concurrency, p50: 1, p95: 2, p99: 3, max: 4, mean: 2 }]))
  const report = {
    reportKind: 'local_disposable_recovery_stress',
    status: 'verified',
    releaseCommit: COMMIT,
    environment: 'local_disposable',
    concurrency,
    requestedSequences: concurrency,
    completedSequences: concurrency,
    failedSequences: 0,
    integrityFailures: 0,
    orchestrationElapsedMs: 100,
    throughputPerSecond: concurrency,
    sequenceElapsedMs: { count: concurrency, p50: 10, p95: 12, p99: 13, max: 14, mean: 11 },
    phaseLatencyMs,
    rto: rtoTargetMs === null
      ? { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' }
      : { targetMs: rtoTargetMs, targetConfigured: true, withinTarget: 14 <= rtoTargetMs, basis: 'operator_supplied_target' },
    releaseEligible: unsafe ? true : false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
  if (resource) {
    report.resourceTelemetry = {
      basis: 'node_process_resource_usage',
      sampleCount: concurrency,
      totals: {
        userCpuTimeUs: 10,
        systemCpuTimeUs: 5,
        fsReadOps: 0,
        fsWriteOps: 0,
        voluntaryContextSwitches: 1,
        involuntaryContextSwitches: 0
      },
      memory: { peakRssKb: 100, maxRssBytes: 1000, maxHeapUsedBytes: 500 },
      perWorkerPeakRssKb: Array.from({ length: concurrency }, () => 100)
    }
  }
  return report
}

async function writeReports(reports) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-baseline-'))
  const paths = []
  for (const report of reports) {
    const filePath = path.join(directory, `c${report.concurrency}.json`)
    await fs.writeFile(filePath, JSON.stringify(report))
    paths.push(filePath)
  }
  return { directory, paths }
}

describe('recovery stress baseline verification', () => {
  it('accepts complete verified 2/4/8 levels with resource telemetry', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true })))
    try {
      const report = await validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT })
      expect(report.status).toBe('verified')
      expect(report.resourceTelemetry).toBe(true)
      expect(report.resourceLevels).toHaveLength(3)
      expect(report.fingerprint).toMatchObject({ algorithm: 'sha256', kind: 'paytray_recovery_stress_baseline_v1' })
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('validates operator RTO target and withinTarget=true when every sequence is within target', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, rtoTargetMs: 20 })))
    try {
      const report = await validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, expectedRtoTargetMs: 20 })
      expect(report.levels.every((level) => level.rto.withinTarget === true)).toBe(true)
      expect(report.levels.every((level) => level.rto.targetConfigured === true)).toBe(true)
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('validates operator RTO target and withinTarget=false when sequence max exceeds target', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, rtoTargetMs: 10 })))
    try {
      const report = await validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, expectedRtoTargetMs: 10 })
      expect(report.levels.every((level) => level.rto.withinTarget === false)).toBe(true)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks unsafe authority fields even when recovery is otherwise verified', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, unsafe: concurrency === 4 })))
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('concurrency 4 has unsafe authority fields')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
