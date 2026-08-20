import { describe, expect, it } from 'vitest'
import { analyzeRecoveryDbCounters } from '../scripts/analyze-recovery-db-counters.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'

function report(concurrency, overrides = {}) {
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: 'verified',
    releaseCommit: commit,
    environment: 'local_disposable',
    concurrency,
    completedSequences: concurrency,
    requestedSequences: concurrency,
    failedSequences: 0,
    integrityFailures: 0,
    orchestrationElapsedMs: 1000,
    sequenceElapsedMs: { p95: 100 + concurrency },
    phaseLatencyMs: { restore: { p95: 50 + concurrency } },
    rto: { targetConfigured: false, withinTarget: null },
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    databaseTelemetry: {
      basis: 'postgresql_observability',
      sampleCount: 100,
      waitEvents: { observations: [{ waitEventType: 'IO', waitEvent: 'DataFileImmediateSync', state: 'active', observations: concurrency, observedBackendCount: concurrency }] },
      snapshotQueryElapsedMs: { count: 10, p50: 1, p95: 2, p99: 3, max: 4, mean: 1.5 },
      wal: { basis: 'pg_stat_wal', deltas: { walRecords: concurrency, walFpi: 1, walBytes: concurrency * 100, walBuffersFull: 0, walWrite: concurrency, walSync: concurrency, walWriteTimeMs: 0, walSyncTimeMs: 0 } },
      io: { basis: 'pg_stat_io', deltas: { ioReads: concurrency, ioWrites: 0, ioWriteTimeMs: 0, ioFsyncs: 0, ioFsyncTimeMs: 0, ioExtends: concurrency, ioExtendTimeMs: 0 } },
      phaseBoundWriteSyncTiming: {
        basis: 'phase_bound_postgresql_write_sync_timing',
        phase: 'restore',
        boundary: 'first_and_last_pg_stat_snapshot',
        sampleCount: 10,
        elapsedMs: 100,
        wal: { walRecords: concurrency, walBytes: concurrency * 100, walWriteCalls: concurrency, walSyncCalls: concurrency, walWriteTimeMs: 0, walSyncTimeMs: 0 },
        io: { ioWriteCalls: 0, ioWriteTimeMs: 0, ioFsyncs: 0, ioFsyncTimeMs: 0, ioExtendCalls: concurrency, ioExtendTimeMs: 0 },
        ratesPerSecond: { walWriteCalls: concurrency * 10, walSyncCalls: concurrency * 10, walWriteTimeMs: 0, walSyncTimeMs: 0, ioWriteCalls: 0, ioFsyncs: 0, ioWriteTimeMs: 0, ioFsyncTimeMs: 0 },
        interpretation: 'diagnostic_phase_bound_counter_timing_not_physical_fsync_proof'
      }
    },
    ...overrides
  }
}

async function reports() {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'paytray-db-counter-'))
  const paths = []
  for (const concurrency of [2, 4, 8]) {
    const file = join(dir, `c${concurrency}.json`)
    await writeFile(file, JSON.stringify(report(concurrency)))
    paths.push(file)
  }
  return paths
}

describe('analyzeRecoveryDbCounters', () => {
  it('aggregates verified c2/c4/c8 WAL, pg_stat_io, snapshot, and wait metrics', async () => {
    const result = await analyzeRecoveryDbCounters({ reportPaths: await reports(), expectedCommit: commit })
    expect(result.status).toBe('verified')
    expect(result.levels.map((level) => level.concurrency)).toEqual([2, 4, 8])
    expect(result.levels[2].wal.walBytes).toBe(800)
    expect(result.levels[2].io.ioExtends).toBe(8)
    expect(result.levels[2].phaseBoundWriteSyncTiming.wal.walSyncCalls).toBe(8)
    expect(result.levels[2].phaseBoundWriteSyncTiming.io.ioExtendCalls).toBe(8)
    expect(result.levels[2].snapshotQuery.max).toBe(4)
    expect(result.levels[2].waitTotals['IO/DataFileImmediateSync']).toBe(8)
    expect(result.releaseEligible).toBe(false)
    expect(result.settlementAuthority).toBe(false)
    expect(result.mutation).toBe('read_only')
  })

  it('blocks a commit mismatch before producing an analysis artifact', async () => {
    await expect(analyzeRecoveryDbCounters({ reportPaths: await reports(), expectedCommit: 'fedcba9876543210fedcba9876543210fedcba98' })).rejects.toThrow('unexpected commit')
  })

  it('blocks malformed pg_stat_io counters', async () => {
    const paths = await reports()
    const { readFile, writeFile } = await import('node:fs/promises')
    const malformed = JSON.parse(await readFile(paths[2], 'utf8'))
    malformed.databaseTelemetry.io.deltas.ioFsyncs = -1
    await writeFile(paths[2], JSON.stringify(malformed))
    await expect(analyzeRecoveryDbCounters({ reportPaths: paths, expectedCommit: commit })).rejects.toThrow('ioFsyncs must be a nonnegative number')
  })

  it('blocks unsafe authority fields', async () => {
    const paths = await reports()
    const { readFile, writeFile } = await import('node:fs/promises')
    const unsafe = JSON.parse(await readFile(paths[0], 'utf8'))
    unsafe.settlementAuthority = true
    await writeFile(paths[0], JSON.stringify(unsafe))
    await expect(analyzeRecoveryDbCounters({ reportPaths: paths, expectedCommit: commit })).rejects.toThrow('unsafe authority fields')
  })
})
