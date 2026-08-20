import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateRecoveryStressBaseline } from '../scripts/verify-recovery-stress-baseline.mjs'

const COMMIT = 'f488f6db0d77a0414c6061f7a1b3e50ca08be105'

function sampleReport(concurrency, { resource = false, database = false, contention = false, unsafe = false, rtoTargetMs = null } = {}) {
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
  if (database) {
    const workerDatabaseTelemetry = {
      basis: 'postgresql_observability',
      sampleCount: 2,
      connectionAcquisitionMs: { count: 2, p50: 1, p95: 2, p99: 2, max: 2, mean: 1.5 },
      waitEvents: { sampleCount: 2, observations: [] },
      databaseStats: { deltas: { tempBytes: 0, tempFiles: 0 } },
      temporaryStorage: { tempBytesDelta: 0, tempFiles: 0, operationElapsedMs: 10, throughputBytesPerSecond: 0 },
      ...(contention ? {
        poolPressure: { sampleCount: 2, maxTotalCount: 2, maxActiveCount: 1, maxWaitingCount: 0, meanWaitingCount: 0, maxUtilizationRatio: 0.5, meanUtilizationRatio: 0.5 },
        wal: { basis: 'pg_stat_wal', deltas: { walRecords: 10, walFpi: 1, walBytes: 100, walBuffersFull: 0, walWrite: 1, walSync: 1, walWriteTimeMs: 2, walSyncTimeMs: 3 } },
        bgwriter: { basis: 'pg_stat_bgwriter', deltas: { buffersCheckpoint: 1, buffersClean: 1, maxwrittenClean: 0, buffersBackend: 1, buffersBackendFsync: 0, checkpointWriteTimeMs: 2, checkpointSyncTimeMs: 1 } }
      } : {}),
      errors: []
    }
    report.databaseTelemetry = {
      basis: 'postgresql_observability',
      workerCount: concurrency,
      sampleCount: concurrency * 2,
      connectionAcquisitionMs: {
        perWorker: Array.from({ length: concurrency }, () => ({ count: 2, p50: 1, p95: 2, p99: 2, max: 2, mean: 1.5 })),
        max: 2
      },
      waitEvents: { sampleCount: concurrency * 2, observations: [] },
      databaseStats: { deltas: { tempBytes: 0, tempFiles: 0 } },
      temporaryStorage: { tempBytesDelta: 0, tempFilesDelta: 0, operationElapsedMs: 10, throughputBytesPerSecond: 0 },
      ...(contention ? {
        poolPressure: { sampleCount: concurrency * 2, maxTotalCount: concurrency, maxActiveCount: concurrency, perWorker: Array.from({ length: concurrency }, () => ({ sampleCount: 2, maxTotalCount: 2, maxActiveCount: 1, maxWaitingCount: 0, meanWaitingCount: 0, maxUtilizationRatio: 0.5, meanUtilizationRatio: 0.5 })), maxWaitingCount: 0, meanWaitingCount: 0, maxUtilizationRatio: 0.5, meanUtilizationRatio: 0.5 },
        wal: { basis: 'pg_stat_wal', deltas: { walRecords: concurrency * 10, walFpi: concurrency, walBytes: concurrency * 100, walBuffersFull: 0, walWrite: concurrency, walSync: concurrency, walWriteTimeMs: concurrency * 2, walSyncTimeMs: concurrency * 3 } },
        bgwriter: { basis: 'pg_stat_bgwriter', deltas: { buffersCheckpoint: concurrency, buffersClean: concurrency, maxwrittenClean: 0, buffersBackend: concurrency, buffersBackendFsync: 0, checkpointWriteTimeMs: concurrency * 2, checkpointSyncTimeMs: concurrency } }
      } : {}),
      errors: []
    }
    report.workers = Array.from({ length: concurrency }, (_, index) => ({
      workerId: `worker-${index + 1}`,
      status: 'verified',
      databaseTelemetry: workerDatabaseTelemetry,
      storageTelemetry: {
        basis: 'local_disposable_backup_file',
        backupBytes: 1000,
        backupDurationMs: 10,
        backupWriteThroughputBytesPerSecond: 100000
      }
    }))
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

  it('accepts required PostgreSQL and backup-storage telemetry for every c2/c4/c8 worker', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, database: true })))
    try {
      const report = await validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, requireDatabaseTelemetry: true })
      expect(report.databaseTelemetry).toBe(true)
      expect(report.databaseLevels).toHaveLength(3)
      expect(report.levels[2].database).toMatchObject({ basis: 'postgresql_observability', workerCount: 8, sampleCount: 16, connectionAcquisitionMaxMs: 2 })
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('accepts strict pool, WAL, and fsync telemetry for every c2/c4/c8 worker', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, database: true, contention: true })))
    try {
      const report = await validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, requireDatabaseTelemetry: true, requireContentionTelemetry: true })
      expect(report.contentionTelemetry).toBe(true)
      expect(report.contentionLevels).toHaveLength(3)
      expect(report.levels[2].database.contention).toMatchObject({ poolPressureMaxWaitingCount: 0, poolPressureMaxUtilizationRatio: 0.5 })
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks malformed WAL contention telemetry in a strict c8 baseline', async () => {
    const reports = [2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, database: true, contention: true }))
    reports[2].databaseTelemetry.wal.deltas.walSync = -1
    const fixture = await writeReports(reports)
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, requireDatabaseTelemetry: true, requireContentionTelemetry: true })).rejects.toThrow('concurrency 8.databaseTelemetry.wal.deltas.walSync must be a nonnegative number')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks malformed connection-acquisition telemetry in a required c8 baseline', async () => {
    const reports = [2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, database: true }))
    reports[2].databaseTelemetry.connectionAcquisitionMs.perWorker[0].max = -1
    const fixture = await writeReports(reports)
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, requireDatabaseTelemetry: true })).rejects.toThrow('connectionAcquisitionMs.perWorker[0].max must be a nonnegative number')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks a required PostgreSQL baseline when c8 telemetry is absent', async () => {
    const fixture = await writeReports([2, 4].map((concurrency) => sampleReport(concurrency, { resource: true, database: true })).concat(sampleReport(8, { resource: true })))
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, requireDatabaseTelemetry: true })).rejects.toThrow('concurrency 8.databaseTelemetry must be an object')
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

  it('blocks an operator target mismatch with a redacted validation error', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, rtoTargetMs: 1 })))
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT, expectedRtoTargetMs: 2 })).rejects.toThrow('concurrency 2 has inconsistent operator RTO target fields')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks a target-bound report when the verifier expects null-target semantics', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { resource: true, rtoTargetMs: 1 })))
    try {
      await expect(validateRecoveryStressBaseline({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow('concurrency 2 must preserve null RTO semantics without an operator target')
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
