import { describe, expect, it } from 'vitest'
import { createRecoveryResourceTelemetry } from '../lib/recoveryResourceTelemetry.js'

function usage({ rssBytes, userCpuTimeUs, systemCpuTimeUs }) {
  return {
    rssBytes,
    heapUsedBytes: 100,
    externalBytes: 20,
    arrayBuffersBytes: 10,
    userCpuTimeUs,
    systemCpuTimeUs,
    maxRssKb: Math.floor(rssBytes / 10),
    fsReadOps: 2,
    fsWriteOps: 3,
    voluntaryContextSwitches: 1,
    involuntaryContextSwitches: 0
  }
}

describe('recovery resource telemetry', () => {
  it('captures process and phase deltas without changing authority fields', async () => {
    const snapshots = [
      usage({ rssBytes: 1000, userCpuTimeUs: 10, systemCpuTimeUs: 5 }),
      usage({ rssBytes: 1010, userCpuTimeUs: 11, systemCpuTimeUs: 5 }),
      usage({ rssBytes: 1200, userCpuTimeUs: 31, systemCpuTimeUs: 9 }),
      usage({ rssBytes: 1300, userCpuTimeUs: 40, systemCpuTimeUs: 12 })
    ]
    const telemetry = createRecoveryResourceTelemetry({ capture: () => snapshots.shift() })
    await telemetry.measure('restore', async () => {})
    const report = telemetry.snapshot()
    expect(report.basis).toBe('node_process_resource_usage')
    expect(report.phases.restore).toMatchObject({
      rssBytes: 1200,
      rssDeltaBytes: 190,
      userCpuTimeUs: 20,
      systemCpuTimeUs: 4
    })
    expect(report.process).toMatchObject({
      rssBytes: 1300,
      rssDeltaBytes: 300,
      userCpuTimeUs: 30,
      systemCpuTimeUs: 7
    })
  })
})
