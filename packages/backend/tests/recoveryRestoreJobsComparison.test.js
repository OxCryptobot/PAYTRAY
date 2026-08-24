import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareRecoveryRestoreJobs } from '../scripts/compare-recovery-restore-jobs.mjs'

const COMMIT = 'b2b3a17e077d960d943079c2d845f083678b4a08'

function duration(value) {
  return { count: 8, p50: value - 10, p95: value, p99: value + 5, max: value + 10, mean: value - 2 }
}

function report(jobLabel, { restoreP95Ms = 1000, sequenceP95Ms = 1500, throughputPerSecond = 1.2, connectionP95Ms = 25, unsafe = false } = {}) {
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: 'verified',
    releaseCommit: COMMIT,
    environment: 'local_disposable',
    concurrency: 8,
    requestedSequences: 8,
    completedSequences: 8,
    failedSequences: 0,
    integrityFailures: 0,
    throughputPerSecond,
    sequenceElapsedMs: duration(sequenceP95Ms),
    phaseLatencyMs: {
      restore: duration(restoreP95Ms)
    },
    childProcessTelemetry: {
      basis: 'procfs_child_process',
      elapsedMs: restoreP95Ms,
      userCpuTimeMs: 100,
      systemCpuTimeMs: 10,
      peakRssKb: 500
    },
    databaseTelemetry: {
      basis: 'postgresql_observability',
      sampleCount: 8,
      connectionAcquisitionMs: { max: connectionP95Ms },
      poolPressure: {
        maxWaitingCount: 0,
        maxUtilizationRatio: 0.5
      }
    },
    restoreJobs: jobLabel === 'serial' ? null : Number(jobLabel),
    rto: {
      targetMs: null,
      targetConfigured: false,
      withinTarget: null
    },
    releaseEligible: unsafe,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

async function writeFixture(reports) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-restore-jobs-'))
  const paths = []
  for (const [index, value] of reports.entries()) {
    const filePath = path.join(directory, `report-${index}.json`)
    await fs.writeFile(filePath, JSON.stringify(value))
    paths.push(filePath)
  }
  return { directory, paths }
}

describe('recovery restore-jobs comparison', () => {
  it('compares serial, jobs=1, jobs=2, and jobs=4 with immutable safety fields', async () => {
    const fixture = await writeFixture([
      report('serial', { restoreP95Ms: 1000, sequenceP95Ms: 1500, throughputPerSecond: 1.2, connectionP95Ms: 25 }),
      report('1', { restoreP95Ms: 900, sequenceP95Ms: 1400, throughputPerSecond: 1.3, connectionP95Ms: 24 }),
      report('2', { restoreP95Ms: 800, sequenceP95Ms: 1300, throughputPerSecond: 1.4, connectionP95Ms: 23 }),
      report('4', { restoreP95Ms: 850, sequenceP95Ms: 1350, throughputPerSecond: 1.35, connectionP95Ms: 30 })
    ])
    try {
      const result = await compareRecoveryRestoreJobs({ reportPaths: fixture.paths, expectedCommit: COMMIT })
      expect(result.status).toBe('verified')
      expect(result.bestObservedSetting).toBe('2')
      expect(result.conclusion).toBe('follow_up_required_before_any_default_change')
      expect(result.boundedComparisons).toHaveLength(3)
      expect(result.boundedComparisons[1].deltaVsSerial.restoreP95Percent).toBe(-20)
      expect(result.boundedComparisons[2].deltaVsSerial.restoreP95Percent).toBe(-15)
      expect(result.releaseEligible).toBe(false)
      expect(result.settlementAuthority).toBe(false)
      expect(result.mutation).toBe('read_only')
      expect(result.deploymentPerformed).toBe(false)
      expect(result.settlementMutationPerformed).toBe(false)
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('retains the serial baseline when no bounded setting improves restore p95', async () => {
    const fixture = await writeFixture([
      report('serial', { restoreP95Ms: 800 }),
      report('1', { restoreP95Ms: 850 }),
      report('2', { restoreP95Ms: 900 }),
      report('4', { restoreP95Ms: 1000 })
    ])
    try {
      const result = await compareRecoveryRestoreJobs({ reportPaths: fixture.paths, expectedCommit: COMMIT })
      expect(result.bestObservedSetting).toBe('serial')
      expect(result.conclusion).toBe('retain_serial_baseline')
      expect(result.boundedComparisons.every((comparison) => comparison.restoreP95ImprovesOnSerial === false)).toBe(true)
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks a report whose restore-jobs field does not match its label', async () => {
    const reports = [report('serial'), report('1'), report('2'), report('4')]
    reports[2].restoreJobs = 4
    const fixture = await writeFixture(reports)
    try {
      await expect(compareRecoveryRestoreJobs({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('restore jobs 2.restoreJobs does not match')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks unsafe authority fields even when every run is otherwise verified', async () => {
    const fixture = await writeFixture([
      report('serial'),
      report('1'),
      report('2', { unsafe: true }),
      report('4')
    ])
    try {
      await expect(compareRecoveryRestoreJobs({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('restore jobs 2 has unsafe authority fields')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
