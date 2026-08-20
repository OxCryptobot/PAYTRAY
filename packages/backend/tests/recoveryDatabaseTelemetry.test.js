import { describe, expect, it } from 'vitest'
import {
  captureDatabaseSnapshot,
  createDatabaseTelemetryCollector,
  mergeDatabaseTelemetry,
  summarizeDatabaseTelemetry
} from '../lib/recoveryDatabaseTelemetry.js'

function clientFixture() {
  return {
    async query(sql) {
      if (sql.includes('pg_stat_activity')) {
        return {
          rows: [
            { wait_event_type: 'Lock', wait_event: 'transactionid', state: 'active', count: 2 },
            { wait_event_type: null, wait_event: null, state: 'idle', count: 1 }
          ]
        }
      }
      return {
        rows: [{
          database_size_bytes: '4096',
          temp_bytes: '1024',
          temp_files: '2',
          blocks_read: '8',
          blocks_hit: '16'
        }]
      }
    },
    release() {}
  }
}

describe('recovery database telemetry', () => {
  it('captures redacted database stats and wait-event groups', async () => {
    const snapshot = await captureDatabaseSnapshot(clientFixture())
    expect(snapshot.stats).toEqual({
      databaseSizeBytes: 4096,
      tempBytes: 1024,
      tempFiles: 2,
      blocksRead: 8,
      blocksHit: 16
    })
    expect(snapshot.waitEvents).toEqual([
      { waitEventType: 'Lock', waitEvent: 'transactionid', state: 'active', count: 2 },
      { waitEventType: 'none', waitEvent: 'none', state: 'idle', count: 1 }
    ])
    expect(snapshot.wal).toMatchObject({ walRecords: 0, walSync: 0, walWrite: 0 })
    expect(snapshot.bgwriter).toMatchObject({ buffersCheckpoint: 0, buffersBackendFsync: 0 })
  })

  it('summarizes connection acquisition, wait observations, and temporary storage deltas', () => {
    const samples = [
      {
        sampledAt: '2026-08-19T20:00:00.000Z',
        connectionAcquisitionMs: 2.5,
        stats: { databaseSizeBytes: 100, tempBytes: 10, tempFiles: 1, blocksRead: 2, blocksHit: 3 },
        snapshotQueryElapsedMs: 1.5,
        waitEvents: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', count: 1 }],
        io: { ioReads: 10, ioWrites: 20, ioWriteTimeMs: 30, ioFsyncs: 4, ioFsyncTimeMs: 5, ioExtends: 6, ioExtendTimeMs: 7 },
        wal: { walRecords: 100, walFpi: 5, walBytes: 1000, walBuffersFull: 1, walWrite: 2, walSync: 3, walWriteTimeMs: 4, walSyncTimeMs: 5 },
        bgwriter: { buffersCheckpoint: 10, buffersClean: 11, maxwrittenClean: 1, buffersBackend: 12, buffersBackendFsync: 2, checkpointWriteTimeMs: 13, checkpointSyncTimeMs: 14 },
        poolPressure: { before: { totalCount: 2, idleCount: 1, activeCount: 1, waitingCount: 0, maxConnections: 2, utilizationRatio: 0.5 }, after: { totalCount: 2, idleCount: 1, activeCount: 1, waitingCount: 0, maxConnections: 2, utilizationRatio: 0.5 } }
      },
      {
        sampledAt: '2026-08-19T20:00:00.100Z',
        connectionAcquisitionMs: 4.5,
        stats: { databaseSizeBytes: 120, tempBytes: 110, tempFiles: 3, blocksRead: 7, blocksHit: 9 },
        snapshotQueryElapsedMs: 2.5,
        waitEvents: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', count: 2 }],
        io: { ioReads: 14, ioWrites: 29, ioWriteTimeMs: 40, ioFsyncs: 7, ioFsyncTimeMs: 9, ioExtends: 9, ioExtendTimeMs: 12 },
        wal: { walRecords: 150, walFpi: 7, walBytes: 1800, walBuffersFull: 3, walWrite: 5, walSync: 8, walWriteTimeMs: 9, walSyncTimeMs: 12 },
        bgwriter: { buffersCheckpoint: 14, buffersClean: 16, maxwrittenClean: 2, buffersBackend: 18, buffersBackendFsync: 3, checkpointWriteTimeMs: 20, checkpointSyncTimeMs: 25 },
        poolPressure: { before: { totalCount: 3, idleCount: 0, activeCount: 3, waitingCount: 2, maxConnections: 3, utilizationRatio: 1 }, after: { totalCount: 3, idleCount: 0, activeCount: 3, waitingCount: 2, maxConnections: 3, utilizationRatio: 1 } }
      }
    ]
    const result = summarizeDatabaseTelemetry(samples, { operationElapsedMs: 100 })
    expect(result.basis).toBe('postgresql_observability')
    expect(result.connectionAcquisitionMs).toMatchObject({ count: 2, p50: 3.5, max: 4.5 })
    expect(result.snapshotQueryElapsedMs).toMatchObject({ count: 2, p50: 2, max: 2.5 })
    expect(result.databaseStats.deltas).toEqual({ databaseSizeBytes: 20, tempBytes: 100, tempFiles: 2, blocksRead: 5, blocksHit: 6 })
    expect(result.temporaryStorage).toMatchObject({ tempBytesDelta: 100, tempFilesDelta: 2, throughputBytesPerSecond: 1000, operationElapsedMs: 100 })
    expect(result.poolPressure).toMatchObject({ sampleCount: 4, maxWaitingCount: 2, maxActiveCount: 3, maxUtilizationRatio: 1, meanWaitingCount: 1 })
    expect(result.wal.deltas).toEqual({ walRecords: 50, walFpi: 2, walBytes: 800, walBuffersFull: 2, walWrite: 3, walSync: 5, walWriteTimeMs: 5, walSyncTimeMs: 7 })
    expect(result.bgwriter.deltas).toEqual({ buffersCheckpoint: 4, buffersClean: 5, maxwrittenClean: 1, buffersBackend: 6, buffersBackendFsync: 1, checkpointWriteTimeMs: 7, checkpointSyncTimeMs: 11 })
    expect(result.io.deltas).toEqual({ ioReads: 4, ioWrites: 9, ioWriteTimeMs: 10, ioFsyncs: 3, ioFsyncTimeMs: 4, ioExtends: 3, ioExtendTimeMs: 5 })
    expect(result.phaseBoundWriteSyncTiming).toMatchObject({
      basis: 'phase_bound_postgresql_write_sync_timing',
      phase: 'restore',
      sampleCount: 2,
      elapsedMs: 100,
      wal: { walRecords: 50, walBytes: 800, walWriteCalls: 3, walSyncCalls: 5, walWriteTimeMs: 5, walSyncTimeMs: 7 },
      io: { ioWriteCalls: 9, ioWriteTimeMs: 10, ioFsyncs: 3, ioFsyncTimeMs: 4 },
      ratesPerSecond: { walSyncCalls: 50, walSyncTimeMs: 70, ioFsyncs: 30 }
    })
    expect(result.waitEvents.observations[0]).toMatchObject({ waitEventType: 'IO', waitEvent: 'DataFileRead', observations: 2, observedBackendCount: 3 })
  })

  it('collects two bounded snapshots and merges worker summaries without raw content', async () => {
    const pool = { options: { max: 4 }, totalCount: 2, idleCount: 1, waitingCount: 0, connect: async () => clientFixture() }
    const collector = createDatabaseTelemetryCollector({ pool, intervalMs: 25, maxSamples: 2 })
    await collector.start()
    const summary = await collector.stop(50)
    expect(summary.basis).toBe('postgresql_observability')
    expect(summary.sampleCount).toBe(2)
    expect(summary.errors).toEqual([])
    expect(summary.poolPressure.maxActiveCount).toBe(1)

    const merged = mergeDatabaseTelemetry([summary, { ...summary, temporaryStorage: { ...summary.temporaryStorage, tempBytesDelta: 4 } }])
    expect(merged.workerCount).toBe(2)
    expect(merged.sampleCount).toBe(4)
    expect(merged.temporaryStorage.tempBytesDelta).toBe(summary.temporaryStorage.tempBytesDelta + 4)
    expect(merged.phaseBoundWriteSyncTiming).toMatchObject({ basis: 'phase_bound_postgresql_write_sync_timing', phase: 'restore', sampleCount: 4 })
    expect(JSON.stringify(merged)).not.toMatch(/password|secret|token|rawContent/i)
  })
})
