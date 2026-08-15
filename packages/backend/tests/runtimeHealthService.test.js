import { describe, expect, it } from 'vitest'
import { buildRuntimeHealthReport } from '../lib/runtimeHealthService.js'

function baseReport(overrides = {}) {
  return buildRuntimeHealthReport({
    requestMetrics: { total: 100, errors: 0, latencies: Array.from({ length: 100 }, () => 100) },
    readiness: { checks: { database: { ready: true } } },
    collaboration: { collaborationAvailable: true, paymentStateMayBeStale: false },
    verifierOperations: { status: 'ready' },
    outboxHealth: { status: 'ok' },
    webhookInboxHealth: { status: 'ok' },
    telemetryHealth: { status: 'ok' },
    databaseStatus: 'ready',
    observability: { availabilityTargetPct: 99, p95LatencyTargetMs: 800, minSamples: 3 },
    ...overrides
  })
}

describe('runtime health and SLO report', () => {
  it('reports healthy only when enough samples and all dependencies are ready', () => {
    const report = baseReport()
    expect(report.status).toBe('ok')
    expect(report.ready).toBe(true)
    expect(report.slo.observed.availabilityPct).toBe(100)
    expect(report.slo.observed.p95LatencyMs).toBe(100)
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
  })

  it('reports degraded when samples are insufficient or verifier evidence is stale', () => {
    const report = baseReport({
      requestMetrics: { total: 1, errors: 0, latencies: [10] },
      verifierOperations: { status: 'blocked', reason: 'verifier status is stale' },
      collaboration: { collaborationAvailable: true, paymentStateMayBeStale: true }
    })
    expect(report.status).toBe('degraded')
    expect(report.ready).toBe(false)
    expect(report.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['apiAvailability', 'apiLatency', 'verifier']))
    expect(report.mutation).toBe('read_only')
    expect(report.deploymentPerformed).toBe(false)
    expect(report.settlementMutationPerformed).toBe(false)
  })
})
