import { describe, expect, it } from 'vitest'
import { buildEngagementThreadProjection } from '../lib/engagementThreadProjection.js'

describe('engagement thread projection', () => {
  it('builds a private thread from a durable engagement', () => {
    const thread = buildEngagementThreadProjection({
      engagement: {
        id: 'engagement-1',
        thread_id: 'thread-1',
        match_session_id: 'match-1',
        scope: 'Ship the integration',
        proposed_terms: { rate: 12 },
        discovery_context: { queryId: 'query-1' },
        collaboration_status: 'ready',
        created_at: '2026-09-03T12:00:00.000Z'
      },
      clientWallet: '0xCLIENT',
      providerWallet: '0xPROVIDER'
    })

    expect(thread).toEqual({
      id: 'thread-1',
      engagementId: 'engagement-1',
      sessionId: 'match-1',
      participants: ['0xclient', '0xprovider'],
      context: {
        objective: 'Ship the integration',
        proposedTerms: { rate: 12 },
        discoveryContext: { queryId: 'query-1' }
      },
      messages: [],
      status: 'ready',
      createdAt: '2026-09-03T12:00:00.000Z',
      lastActivityAt: '2026-09-03T12:00:00.000Z',
      messageCount: 0,
      safety: {
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only'
      }
    })
  })

  it('uses safe defaults and a deterministic injected clock', () => {
    const thread = buildEngagementThreadProjection({
      engagement: { id: 'engagement-2', thread_id: 'thread-2' },
      clientWallet: '0xA',
      providerWallet: '0xB',
      now: () => '2026-09-03T13:00:00.000Z'
    })

    expect(thread).toMatchObject({
      id: 'thread-2',
      participants: ['0xa', '0xb'],
      status: 'ready',
      createdAt: '2026-09-03T13:00:00.000Z',
      context: { objective: 'collaboration engagement', proposedTerms: {}, discoveryContext: {} }
    })
  })

  it('returns no projection when the durable record has no thread id', () => {
    expect(buildEngagementThreadProjection({ engagement: { id: 'engagement-3' }, clientWallet: '0xA', providerWallet: '0xB' })).toBeNull()
  })
})
