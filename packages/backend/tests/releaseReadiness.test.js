import { describe, expect, it } from 'vitest'
import { getReleaseReadiness } from '../lib/releaseReadiness.js'

const config = {
  env: 'test',
  payments: { protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d' }
}

function client({ verified = 1, unverified = 0, pendingReviews = 0 } = {}) {
  return {
    async query(sql) {
      if (sql.includes('production_telemetry_events')) {
        if (sql.includes('percentile_cont')) return { rows: [] }
        if (sql.includes('GROUP BY event_type')) return { rows: [] }
        return { rows: [{ total_events: '10', events_last_24h: '10', average_ingestion_lag_ms: '2', max_ingestion_lag_ms: '5', restricted_events: '0' }] }
      }
      if (sql.includes('ai_evaluation_runs')) return { rows: [{ shadow_runs: '1', pending_reviews: String(pendingReviews), approved_pilot_runs: '0' }] }
      if (sql.includes('engagement_outcome_events')) return { rows: [{ verified_outcomes: String(verified), unverified_outcomes: String(unverified), total_outcomes: String(verified + unverified) }] }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
}

describe('release readiness', () => {
  it('reports shadow pilot readiness only after verified coverage and review clearance', async () => {
    const readiness = await getReleaseReadiness({ client: client(), config, databaseStatus: 'ready', enabledTokenCount: 1 })
    expect(readiness.status).toBe('shadow_pilot_ready')
    expect(readiness.promotionStatus).toBe('shadow_only')
    expect(readiness.checks.promotionAuthority.ready).toBe(false)
  })

  it('blocks readiness when verified outcomes or shadow review clearance is missing', async () => {
    const readiness = await getReleaseReadiness({ client: client({ verified: 0, unverified: 2, pendingReviews: 1 }), config, databaseStatus: 'ready', enabledTokenCount: 1 })
    expect(readiness.status).toBe('not_ready')
    expect(readiness.checks.verifiedOutcomeCoverage.ready).toBe(false)
    expect(readiness.checks.shadowReview.ready).toBe(false)
  })
})
