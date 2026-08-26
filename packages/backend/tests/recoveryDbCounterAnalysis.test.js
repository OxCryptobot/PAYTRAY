import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeRecoveryDbCounters } from '../scripts/analyze-recovery-db-counters.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'
const backendDirectory = process.cwd()
const databaseCounterScriptPath = path.join(backendDirectory, 'scripts', 'analyze-recovery-db-counters.mjs')

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-db-counter-'))
  const paths = []
  for (const concurrency of [2, 4, 8]) {
    const file = path.join(dir, `c${concurrency}.json`)
    await fs.writeFile(file, JSON.stringify(report(concurrency)))
    paths.push(file)
  }
  return { directory: dir, paths }
}

describe('analyzeRecoveryDbCounters', () => {
  it('aggregates verified c2/c4/c8 WAL, pg_stat_io, snapshot, and wait metrics', async () => {
    const fixture = await reports()
    try {
      const result = await analyzeRecoveryDbCounters({ reportPaths: fixture.paths, expectedCommit: commit })
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
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and non-regular report inputs in the CLI before parsing', async () => {
    const fixture = await reports()
    const inputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-db-counter-inputs-'))
    try {
      const symlinkPath = path.join(inputDirectory, 'c2-link.json')
      const directoryPath = path.join(inputDirectory, 'c2-directory')
      await fs.symlink(fixture.paths[0], symlinkPath)
      await fs.mkdir(directoryPath)

      for (const [inputPath, reason] of [[symlinkPath, `${symlinkPath} must not be a symlink`], [directoryPath, `${directoryPath} must be a regular file`]]) {
        const reportPaths = [inputPath, fixture.paths[1], fixture.paths[2]].join(',')
        let error
        try {
          execFileSync(process.execPath, [databaseCounterScriptPath], {
            cwd: backendDirectory,
            encoding: 'utf8',
            env: { ...process.env, RECOVERY_STRESS_REPORTS: reportPaths, RECOVERY_STRESS_EXPECTED_COMMIT: commit }
          })
        } catch (caught) {
          error = caught
        }
        expect(error?.status).toBe(1)
        expect(JSON.parse(error?.stderr || error?.stdout)).toMatchObject({ reportKind: 'local_disposable_recovery_database_counter_analysis', status: 'blocked', reason, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
      }
    } finally {
      await fs.rm(inputDirectory, { recursive: true, force: true })
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks a commit mismatch before producing an analysis artifact', async () => {
    const fixture = await reports()
    try {
      await expect(analyzeRecoveryDbCounters({ reportPaths: fixture.paths, expectedCommit: 'fedcba9876543210fedcba9876543210fedcba98' })).rejects.toThrow('unexpected commit')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks malformed pg_stat_io counters', async () => {
    const fixture = await reports()
    const malformed = JSON.parse(await fs.readFile(fixture.paths[2], 'utf8'))
    malformed.databaseTelemetry.io.deltas.ioFsyncs = -1
    await fs.writeFile(fixture.paths[2], JSON.stringify(malformed))
    try {
      await expect(analyzeRecoveryDbCounters({ reportPaths: fixture.paths, expectedCommit: commit })).rejects.toThrow('ioFsyncs must be a nonnegative number')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('blocks unsafe authority fields', async () => {
    const fixture = await reports()
    const unsafe = JSON.parse(await fs.readFile(fixture.paths[0], 'utf8'))
    unsafe.settlementAuthority = true
    await fs.writeFile(fixture.paths[0], JSON.stringify(unsafe))
    try {
      await expect(analyzeRecoveryDbCounters({ reportPaths: fixture.paths, expectedCommit: commit })).rejects.toThrow('unsafe authority fields')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })
})
