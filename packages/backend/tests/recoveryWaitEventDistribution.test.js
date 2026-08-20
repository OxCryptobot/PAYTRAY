import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { aggregateRecoveryWaitEvents } from '../scripts/aggregate-recovery-wait-events.mjs'

const COMMIT = 'ea78e6677f86532dedae0a55045c731d325558a6'
const PHASES = ['backup', 'backup_integrity', 'catalog', 'restore', 'restore_verification']

function sampleReport(concurrency, { unsafe = false, commit = COMMIT, waitEvent = 'DataFileImmediateSync' } = {}) {
  const workers = Array.from({ length: concurrency }, (_, index) => ({
    workerId: `worker-${index + 1}`,
    status: 'verified',
    recoveryElapsedMs: 100 + index,
    databaseTelemetry: {
      basis: 'postgresql_observability',
      sampleCount: 4,
      connectionAcquisitionMs: { count: 4, p50: 1, p95: 2, p99: 3, max: 4 + index, mean: 1.5 },
      waitEvents: {
        sampleCount: 4,
        observations: [
          { waitEventType: 'IO', waitEvent, state: 'active', observations: index + 1, observedBackendCount: index + 1 },
          { waitEventType: 'none', waitEvent: 'none', state: 'active', observations: 4, observedBackendCount: 5 }
        ]
      },
      temporaryStorage: { tempBytesDelta: index * 10, tempFilesDelta: index, operationElapsedMs: 8, throughputBytesPerSecond: 0 },
      errors: []
    },
    storageTelemetry: { basis: 'local_disposable_backup_file', backupBytes: 1000, backupDurationMs: 10, backupWriteThroughputBytesPerSecond: 100000 }
  }))
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: 'verified',
    releaseCommit: commit,
    environment: 'local_disposable',
    concurrency,
    requestedSequences: concurrency,
    completedSequences: concurrency,
    failedSequences: 0,
    integrityFailures: 0,
    sequenceElapsedMs: { count: concurrency, p50: 100, p95: 110, p99: 111, max: 112, mean: 105 },
    phaseLatencyMs: Object.fromEntries(PHASES.map((phase) => [phase, { count: concurrency, p50: 1, p95: 2, p99: 3, max: 4, mean: 2 }])),
    databaseTelemetry: {
      basis: 'postgresql_observability',
      workerCount: concurrency,
      sampleCount: concurrency * 4,
      connectionAcquisitionMs: { max: 4 + concurrency },
      waitEvents: { sampleCount: concurrency * 4, observations: [] },
      temporaryStorage: { tempBytesDelta: workers.reduce((sum, worker) => sum + worker.databaseTelemetry.temporaryStorage.tempBytesDelta, 0), tempFilesDelta: 0, operationElapsedMs: 10, throughputBytesPerSecond: 0 },
      errors: []
    },
    rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
    workers,
    releaseEligible: unsafe ? true : false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

async function writeReports(reports) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-wait-events-'))
  const paths = []
  for (const report of reports) {
    const filePath = path.join(directory, `c${report.concurrency}.json`)
    await fs.writeFile(filePath, JSON.stringify(report))
    paths.push(filePath)
  }
  return { directory, paths }
}

describe('recovery wait-event distribution aggregation', () => {
  it('aggregates exact c2/c4/c8 worker wait events and connection maxima', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency)))
    try {
      const report = await aggregateRecoveryWaitEvents({ reportPaths: fixture.paths, expectedCommit: COMMIT })
      expect(report.status).toBe('verified')
      expect(report.levels).toHaveLength(3)
      expect(report.levels[2].workerCount).toBe(8)
      expect(report.levels[2].connectionAcquisitionMaxMs.max).toBe(11)
      expect(report.levels[2].temporaryStorage.tempBytesDeltaTotal).toBe(280)
      expect(report.levels[2].waitEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ waitEvent: 'DataFileImmediateSync', observations: 36, workersObserved: 8 }),
        expect.objectContaining({ waitEvent: 'none', observations: 32, workersObserved: 8 })
      ]))
      expect(report.fingerprint).toMatchObject({ algorithm: 'sha256', kind: 'paytray_recovery_wait_event_distribution_v1' })
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects a report bound to a different commit', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { commit: concurrency === 8 ? 'f488f6db0d77a0414c6061f7a1b3e50ca08be105' : COMMIT })))
    try {
      await expect(aggregateRecoveryWaitEvents({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('all reports must bind to expectedCommit')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects unsafe authority fields and target-bound comparison reports', async () => {
    const unsafeFixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { unsafe: concurrency === 4 })))
    try {
      await expect(aggregateRecoveryWaitEvents({ reportPaths: unsafeFixture.paths, expectedCommit: COMMIT })).rejects.toThrow('concurrency 4 has unsafe authority fields')
    } finally {
      await fs.rm(unsafeFixture.directory, { recursive: true, force: true })
    }
    const targetFixture = await writeReports([2, 4, 8].map((concurrency) => ({ ...sampleReport(concurrency), rto: { targetMs: 1, targetConfigured: true, withinTarget: false, basis: 'operator_supplied_target' } })))
    try {
      await expect(aggregateRecoveryWaitEvents({ reportPaths: targetFixture.paths, expectedCommit: COMMIT })).rejects.toThrow('must use null-target RTO semantics')
    } finally {
      await fs.rm(targetFixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects control characters in wait-event labels', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { waitEvent: concurrency === 8 ? 'WAL\u0000Write' : 'DataFileImmediateSync' })))
    try {
      await expect(aggregateRecoveryWaitEvents({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('waitEvent is invalid')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
