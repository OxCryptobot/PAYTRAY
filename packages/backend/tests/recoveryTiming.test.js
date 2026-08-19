import { describe, expect, it } from 'vitest'
import { createRecoveryTiming } from '../lib/recoveryTiming.js'

describe('recovery timing evidence', () => {
  it('records phase durations and a configured RTO comparison deterministically', async () => {
    let now = 1000
    const timing = createRecoveryTiming({ clock: () => now })
    now = 1100
    await timing.measure('backup', async () => {
      now = 1400
    })
    now = 1500
    const report = timing.snapshot({ rtoTargetMs: 1000 })

    expect(report.elapsedMs).toBe(500)
    expect(report.phases.backup).toEqual({ status: 'ok', durationMs: 300 })
    expect(report.rto).toEqual({
      targetMs: 1000,
      targetConfigured: true,
      withinTarget: true,
      basis: 'operator_supplied'
    })
    expect(report.startedAt).toBe(new Date(1000).toISOString())
    expect(report.completedAt).toBe(new Date(1500).toISOString())
  })

  it('records blocked phase timing and leaves RTO comparison null when no target is supplied', async () => {
    let now = 2000
    const timing = createRecoveryTiming({ clock: () => now })
    now = 2050
    await expect(timing.measure('restore', async () => {
      now = 2300
      throw new Error('restore failed')
    })).rejects.toThrow('restore failed')
    now = 2400
    const report = timing.snapshot()

    expect(report.phases.restore).toEqual({ status: 'blocked', durationMs: 250 })
    expect(report.rto).toEqual({
      targetMs: null,
      targetConfigured: false,
      withinTarget: null,
      basis: 'not_configured'
    })
  })
})
