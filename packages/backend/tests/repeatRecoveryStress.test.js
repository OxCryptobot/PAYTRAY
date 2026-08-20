import { describe, expect, it } from 'vitest'
import { buildRepeatedStressReport } from '../scripts/repeat-recovery-stress.mjs'

function report(concurrency, repetition, overrides = {}) {
  return {
    concurrency,
    repetition,
    report: {
      status: 'verified',
      failedSequences: 0,
      integrityFailures: 0,
      throughputPerSecond: concurrency * 1.5 + repetition / 10,
      sequenceElapsedMs: { p95: 200 + concurrency * 10 + repetition, p99: 220 + concurrency * 10 + repetition },
      phaseLatencyMs: { restore: { p95: 100 + concurrency * 5 + repetition } },
      resourceTelemetry: { memory: { peakRssKb: 50000 + concurrency * 100 + repetition }, totals: { userCpuTimeUs: 1000 + repetition } },
      databaseTelemetry: {
        basis: 'postgresql_observability',
        temporaryStorage: { tempBytesDelta: concurrency * 10 + repetition },
        connectionAcquisitionMs: { max: 2 + repetition },
        snapshotQueryElapsedMs: { count: 2, p50: 1, p95: 2, p99: 2, max: 2, mean: 1.5 },
        poolPressure: { maxWaitingCount: repetition, maxUtilizationRatio: 0.5 },
        wal: { basis: 'pg_stat_wal', deltas: { walRecords: 10, walBytes: 100, walWrite: 2, walSync: 3, walWriteTimeMs: 4, walSyncTimeMs: 5, walFpi: 1, walBuffersFull: 0 } },
        bgwriter: { basis: 'pg_stat_bgwriter', deltas: { buffersCheckpoint: 1, buffersClean: 1, maxwrittenClean: 0, buffersBackend: 2, buffersBackendFsync: 1, checkpointWriteTimeMs: 3, checkpointSyncTimeMs: 4 } },
        io: { basis: 'pg_stat_io', deltas: { ioReads: 1, ioWrites: 2, ioWriteTimeMs: 3, ioFsyncs: 4, ioFsyncTimeMs: 5, ioExtends: 6, ioExtendTimeMs: 7 } },
        phaseBoundWriteSyncTiming: {
          basis: 'phase_bound_postgresql_write_sync_timing',
          phase: 'restore',
          boundary: 'first_and_last_pg_stat_snapshot',
          sampleCount: 2,
          elapsedMs: 100,
          wal: { walRecords: 10, walBytes: 100, walWriteCalls: 2, walSyncCalls: 3, walWriteTimeMs: 4, walSyncTimeMs: 5 },
          io: { ioWriteCalls: 2, ioWriteTimeMs: 3, ioFsyncs: 4, ioFsyncTimeMs: 5, ioExtendCalls: 6, ioExtendTimeMs: 7 },
          ratesPerSecond: { walWriteCalls: 20, walSyncCalls: 30, walWriteTimeMs: 40, walSyncTimeMs: 50, ioWriteCalls: 20, ioFsyncs: 40, ioWriteTimeMs: 30, ioFsyncTimeMs: 50 },
          interpretation: 'diagnostic_phase_bound_counter_timing_not_physical_fsync_proof'
        },
        waitEvents: { observations: [] }
      },
      rto: { targetMs: 500, targetConfigured: true, withinTarget: true }
    },
    ...overrides
  }
}

describe('repeated recovery stress confidence aggregation', () => {
  it('aggregates complete c2/c4/c8 repetitions with confidence intervals', () => {
    const runResults = [2, 4, 8].flatMap((concurrency) => [1, 2, 3].map((repetition) => report(concurrency, repetition)))
    const result = buildRepeatedStressReport({
      commit: '586492474d24cff7495a0703569ecb5e20134309',
      repetitions: 3,
      concurrencyLevels: [2, 4, 8],
      targetMs: 500,
      runResults,
      requireContentionTelemetry: true
    })
    expect(result.status).toBe('verified')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.levels).toHaveLength(3)
    expect(result.levels[2]).toMatchObject({ concurrency: 8, repetitionCount: 3, allVerified: true, integrityFailures: 0 })
    expect(result.levels[2].sequenceP95Ms.confidence95.method).toBe('two_sided_student_t')
    expect(result.levels[2].databaseTempBytes.mean).toBeGreaterThan(0)
    expect(result.levels[2].poolMaxWaitingCount.mean).toBe(2)
    expect(result.levels[2].poolMaxUtilizationRatio.mean).toBe(0.5)
    expect(result.levels[2].walSync.mean).toBe(3)
    expect(result.levels[2].buffersBackendFsync.mean).toBe(1)
    expect(result.levels[2].ioFsyncs.mean).toBe(4)
    expect(result.levels[2].snapshotQueryMaxMs.mean).toBe(2)
    expect(result.levels[2].phaseBoundWalSyncTimeMs.mean).toBe(5)
    expect(result.levels[2].phaseBoundIoFsyncTimeMs.mean).toBe(5)
    expect(result.contentionTelemetry).toBe(true)
    expect(result.levels[2].rto).toMatchObject({ targetMs: 500, withinTargetCount: 3, evaluatedRuns: 3, withinTargetRate: 1 })
    expect(result.safety).toEqual({
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
  })

  it('blocks missing contention telemetry when strict mode is enabled', () => {
    const runResults = [2, 4, 8].flatMap((concurrency) => [1, 2, 3].map((repetition) => report(concurrency, repetition)))
    delete runResults[0].report.databaseTelemetry.wal
    expect(() => buildRepeatedStressReport({
      commit: '586492474d24cff7495a0703569ecb5e20134309',
      repetitions: 3,
      concurrencyLevels: [2, 4, 8],
      runResults,
      requireContentionTelemetry: true
    })).toThrow('concurrency 2 is missing pool/WAL/bgwriter/io/phase-bound timing telemetry')
  })

  it('blocks incomplete repetition coverage and preserves failure counts', () => {
    const runResults = [2, 4, 8].flatMap((concurrency) => [1, 2].map((repetition) => report(concurrency, repetition)))
    runResults.push(report(8, 3, { report: { ...report(8, 3).report, status: 'blocked', integrityFailures: 1 } }))
    const result = buildRepeatedStressReport({
      commit: '586492474d24cff7495a0703569ecb5e20134309',
      repetitions: 3,
      concurrencyLevels: [2, 4, 8],
      runResults
    })
    expect(result.status).toBe('blocked')
    expect(result.levels.find((level) => level.concurrency === 8)).toMatchObject({ allVerified: false, integrityFailures: 1 })
  })
})
