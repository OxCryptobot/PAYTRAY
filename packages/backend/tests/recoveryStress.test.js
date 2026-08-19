import { describe, expect, it } from 'vitest'
import { buildStressReport } from '../scripts/stress-recovery-sequence.mjs'

describe('recovery stress report aggregation', () => {
  const worker = (workerId, elapsedMs, phaseOffset = 0, status = 'verified') => ({
    workerId,
    orchestrationElapsedMs: elapsedMs + 10,
    report: {
      status,
      timing: {
        elapsedMs,
        resource: {
          process: {
            basis: 'node_process_resource_usage',
            rssBytes: 1000 + elapsedMs,
            heapUsedBytes: 500,
            externalBytes: 100,
            arrayBuffersBytes: 50,
            peakRssKb: 100 + elapsedMs,
            userCpuTimeUs: 20,
            systemCpuTimeUs: 10,
            fsReadOps: 3,
            fsWriteOps: 4,
            voluntaryContextSwitches: 2,
            involuntaryContextSwitches: 1
          }
        },
        phases: {
          backup: { durationMs: 200 + phaseOffset },
          backup_integrity: { durationMs: 2 },
          catalog: { durationMs: 80 + phaseOffset },
          restore: { durationMs: 190 + phaseOffset },
          restore_verification: { durationMs: 20 }
        }
      },
      restore: { status }
    }
  })

  it('aggregates successful workers, throughput, percentiles, and an operator RTO target', () => {
    const report = buildStressReport({
      commit: '5576f975f8fa47bfbaa2df0cf40ea2977a2dfa64',
      concurrency: 2,
      requestedSequences: 2,
      workerResults: [worker('worker-1', 500), worker('worker-2', 600, 10)],
      orchestrationElapsedMs: 1000,
      targetMs: 700
    })

    expect(report.status).toBe('verified')
    expect(report.completedSequences).toBe(2)
    expect(report.failedSequences).toBe(0)
    expect(report.integrityFailures).toBe(0)
    expect(report.throughputPerSecond).toBe(2)
    expect(report.sequenceElapsedMs.p50).toBe(550)
    expect(report.phaseLatencyMs.backup.max).toBe(210)
    expect(report.resourceTelemetry).toMatchObject({
      basis: 'node_process_resource_usage',
      sampleCount: 2,
      totals: {
        userCpuTimeUs: 40,
        systemCpuTimeUs: 20,
        fsReadOps: 6,
        fsWriteOps: 8,
        voluntaryContextSwitches: 4,
        involuntaryContextSwitches: 2
      },
      memory: {
        peakRssKb: 700,
        maxRssBytes: 1600
      }
    })
    expect(report.rto).toEqual({
      targetMs: 700,
      targetConfigured: true,
      withinTarget: true,
      basis: 'operator_supplied_target'
    })
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
    expect(report.mutation).toBe('read_only')
  })

  it('leaves withinTarget null without an operator target', () => {
    const report = buildStressReport({
      commit: '5576f975f8fa47bfbaa2df0cf40ea2977a2dfa64',
      concurrency: 2,
      requestedSequences: 2,
      workerResults: [worker('worker-1', 500), worker('worker-2', 600)],
      orchestrationElapsedMs: 1000
    })

    expect(report.rto).toEqual({
      targetMs: null,
      targetConfigured: false,
      withinTarget: null,
      basis: 'not_configured'
    })
  })

  it('blocks the report when a worker fails or restored integrity is not verified', () => {
    const report = buildStressReport({
      commit: '5576f975f8fa47bfbaa2df0cf40ea2977a2dfa64',
      concurrency: 2,
      requestedSequences: 2,
      workerResults: [worker('worker-1', 500), worker('worker-2', 600, 0, 'blocked')],
      orchestrationElapsedMs: 1000
    })

    expect(report.status).toBe('blocked')
    expect(report.completedSequences).toBe(1)
    expect(report.failedSequences).toBe(1)
    expect(report.integrityFailures).toBe(1)
    expect(report.rto.withinTarget).toBeNull()
  })
})
