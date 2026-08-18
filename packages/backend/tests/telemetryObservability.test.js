import { describe, expect, it } from 'vitest'
import { getTelemetryHealth } from '../lib/telemetryObservability.js'

describe('Paytray telemetry observability', () => {
  it('summarizes lag, coverage, and shadow-review health without granting authority', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('FROM production_telemetry_events')) {
          if (sql.includes('percentile_cont')) return { rows: [{ event_type: 'discovery_impression', count: '4', median_lag_ms: '100.00', p95_lag_ms: '300.00' }, { event_type: 'outcome_verified', count: '2', median_lag_ms: '150.00', p95_lag_ms: '450.00' }] }
          if (sql.includes('GROUP BY event_type')) return { rows: [{ event_type: 'discovery_impression', count: '4' }, { event_type: 'outcome_verified', count: '2' }] }
          return { rows: [{ total_events: '6', events_last_24h: '6', average_ingestion_lag_ms: '125.50', max_ingestion_lag_ms: '450', restricted_events: '0' }] }
        }
        if (sql.includes('FROM ai_evaluation_runs')) return { rows: [{ shadow_runs: '2', pending_reviews: '2', approved_pilot_runs: '0' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }

    const health = await getTelemetryHealth({ client, now: new Date('2026-08-14T19:00:00.000Z') })
    expect(health.status).toBe('ok')
    expect(health.ingestion.averageLagMs).toBe(125.5)
    expect(health.coverage.outcome_verified).toBe(2)
    expect(health.ingestion.byEventType.discovery_impression.p95LagMs).toBe(300)
    expect(health.shadowEvaluation.pendingReviews).toBe(2)
    expect(health.performance.sampleCount).toBe(6)
    expect(health.performance.sampleSufficient).toBe(true)
    expect(health.performance.p95LagMs).toBe(450)
    expect(health.performance.withinTarget).toBe(true)
    expect(health.safety).toEqual({
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
  })

  it('does not claim a performance target result before the minimum sample count', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('FROM production_telemetry_events')) {
          if (sql.includes('percentile_cont')) return { rows: [{ event_type: 'outcome_verified', count: '1', median_lag_ms: '900.00', p95_lag_ms: '900.00' }] }
          if (sql.includes('GROUP BY event_type')) return { rows: [{ event_type: 'outcome_verified', count: '1' }] }
          return { rows: [{ total_events: '1', events_last_24h: '1', average_ingestion_lag_ms: '900.00', max_ingestion_lag_ms: '900.00', restricted_events: '0' }] }
        }
        if (sql.includes('FROM ai_evaluation_runs')) return { rows: [{ shadow_runs: '0', pending_reviews: '0', approved_pilot_runs: '0' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }

    const health = await getTelemetryHealth({ client, minSamples: 3, p95LatencyTargetMs: 800 })
    expect(health.performance.sampleSufficient).toBe(false)
    expect(health.performance.withinTarget).toBeNull()
    expect(health.safety.releaseEligible).toBe(false)
  })
})
