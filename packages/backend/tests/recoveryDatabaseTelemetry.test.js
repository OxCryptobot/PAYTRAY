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
  })

  it('summarizes connection acquisition, wait observations, and temporary storage deltas', () => {
    const samples = [
      {
        sampledAt: '2026-08-19T20:00:00.000Z',
        connectionAcquisitionMs: 2.5,
        stats: { databaseSizeBytes: 100, tempBytes: 10, tempFiles: 1, blocksRead: 2, blocksHit: 3 },
        waitEvents: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', count: 1 }]
      },
      {
        sampledAt: '2026-08-19T20:00:00.100Z',
        connectionAcquisitionMs: 4.5,
        stats: { databaseSizeBytes: 120, tempBytes: 110, tempFiles: 3, blocksRead: 7, blocksHit: 9 },
        waitEvents: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', count: 2 }]
      }
    ]
    const result = summarizeDatabaseTelemetry(samples, { operationElapsedMs: 100 })
    expect(result.basis).toBe('postgresql_observability')
    expect(result.connectionAcquisitionMs).toMatchObject({ count: 2, p50: 3.5, max: 4.5 })
    expect(result.databaseStats.deltas).toEqual({ databaseSizeBytes: 20, tempBytes: 100, tempFiles: 2, blocksRead: 5, blocksHit: 6 })
    expect(result.temporaryStorage).toMatchObject({ tempBytesDelta: 100, tempFilesDelta: 2, throughputBytesPerSecond: 1000, operationElapsedMs: 100 })
    expect(result.waitEvents.observations[0]).toMatchObject({ waitEventType: 'IO', waitEvent: 'DataFileRead', observations: 2, observedBackendCount: 3 })
  })

  it('collects two bounded snapshots and merges worker summaries without raw content', async () => {
    const pool = { connect: async () => clientFixture() }
    const collector = createDatabaseTelemetryCollector({ pool, intervalMs: 25, maxSamples: 2 })
    await collector.start()
    const summary = await collector.stop(50)
    expect(summary.basis).toBe('postgresql_observability')
    expect(summary.sampleCount).toBe(2)
    expect(summary.errors).toEqual([])

    const merged = mergeDatabaseTelemetry([summary, { ...summary, temporaryStorage: { ...summary.temporaryStorage, tempBytesDelta: 4 } }])
    expect(merged.workerCount).toBe(2)
    expect(merged.sampleCount).toBe(4)
    expect(merged.temporaryStorage.tempBytesDelta).toBe(summary.temporaryStorage.tempBytesDelta + 4)
    expect(JSON.stringify(merged)).not.toMatch(/password|secret|token|rawContent/i)
  })
})
