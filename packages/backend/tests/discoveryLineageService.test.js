import { describe, expect, it } from 'vitest'
import { listDiscoveryOutcomeLineage } from '../lib/discoveryLineageService.js'

describe('discovery outcome lineage service', () => {
  it('groups impression outcomes and labels verified lineage without raw content', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '1' }] }
        return {
          rows: [
            {
              impression_id: 'impression-1',
              query_id: 'query-1',
              candidate_profile_id: 'profile-1',
              engagement_id: 'engagement-1',
              rank_position: 1,
              ranking_version: 'weighted-explainable-v1',
              selected: true,
              observed_at: '2026-08-15T02:00:00.000Z',
              provenance: { source: 'discovery_v2' },
              outcome_id: 'outcome-1',
              event_type: 'meeting_completed',
              evidence_type: 'session',
              evidence_id: 'session-1',
              verification_status: 'verified',
              outcome_occurred_at: '2026-08-15T02:05:00.000Z'
            },
            {
              impression_id: 'impression-1',
              query_id: 'query-1',
              candidate_profile_id: 'profile-1',
              engagement_id: 'engagement-1',
              rank_position: 1,
              ranking_version: 'weighted-explainable-v1',
              selected: true,
              observed_at: '2026-08-15T02:00:00.000Z',
              provenance: { source: 'discovery_v2' },
              outcome_id: 'outcome-2',
              event_type: 'paid_minutes_delivered',
              evidence_type: 'payment_chain_event',
              evidence_id: 'chain-event-1',
              verification_status: 'unverified',
              outcome_occurred_at: '2026-08-15T02:06:00.000Z'
            }
          ]
        }
      }
    }

    const result = await listDiscoveryOutcomeLineage({
      client,
      queryId: 'query-1',
      verificationStatus: 'verified',
      limit: '10',
      offset: '0'
    })

    expect(result).toMatchObject({
      status: 'ok',
      authority: 'verified_outcome_lineage',
      mutation: 'read_only',
      rawContentIncluded: false,
      pagination: { limit: 10, offset: 0, total: 1, hasMore: false }
    })
    expect(result.impressions).toHaveLength(1)
    expect(result.impressions[0]).toMatchObject({
      impressionId: 'impression-1',
      lineageStatus: 'verified_outcome',
      outcomes: [
        { id: 'outcome-1', verificationStatus: 'verified' },
        { id: 'outcome-2', verificationStatus: 'unverified' }
      ]
    })
    expect(result.impressions[0]).not.toHaveProperty('queryFeatures')
    expect(result.impressions[0]).not.toHaveProperty('matchExplanation')
    expect(calls[0].params).toEqual(['query-1', 'verified'])
    expect(calls[1].params).toEqual(['query-1', 'verified', 10, 0])
  })

  it('rejects unsupported verification filters', async () => {
    const client = { query: async () => ({ rows: [] }) }
    await expect(listDiscoveryOutcomeLineage({ client, verificationStatus: 'approved' }))
      .rejects.toThrow('verificationStatus must be verified, unverified, or rejected')
  })
})
