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
      runResults
    })
    expect(result.status).toBe('verified')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.levels).toHaveLength(3)
    expect(result.levels[2]).toMatchObject({ concurrency: 8, repetitionCount: 3, allVerified: true, integrityFailures: 0 })
    expect(result.levels[2].sequenceP95Ms.confidence95.method).toBe('two_sided_student_t')
    expect(result.levels[2].databaseTempBytes.mean).toBeGreaterThan(0)
    expect(result.levels[2].rto).toMatchObject({ targetMs: 500, withinTargetCount: 3, evaluatedRuns: 3, withinTargetRate: 1 })
    expect(result.safety).toEqual({
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
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
