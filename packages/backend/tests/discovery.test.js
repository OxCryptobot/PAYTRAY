import { describe, expect, it } from 'vitest'
import { rankExpertCandidates, SCORE_WEIGHTS } from '../lib/discoveryService.js'

describe('Paytray discovery v1', () => {
  const candidates = [
    {
      id: 'expert-a',
      name: 'Avery Protocol',
      bio: 'Builds resilient ERC20 streaming systems',
      expertise: ['Solidity', 'Streaming', 'DeFi'],
      availability_status: 'today',
      verification_status: 'verified',
      hourly_rate: '180',
      paid_minutes: 1200,
      completion_rate: '0.96',
      repeat_booking_rate: '0.4',
      response_latency_seconds: 3600
    },
    {
      id: 'expert-b',
      name: 'Bryn Product',
      bio: 'Marketplace product systems',
      expertise: ['Product', 'Discovery'],
      availability_status: 'this_week',
      verification_status: 'unverified',
      hourly_rate: '100',
      paid_minutes: 30,
      completion_rate: '0.75',
      repeat_booking_rate: '0.05',
      response_latency_seconds: 7200
    }
  ]

  it('ranks skill and verified outcome fit with an auditable explanation', () => {
    const [best] = rankExpertCandidates(candidates, { query: 'ERC20 streaming', maxHourlyRate: 200 })

    expect(best.id).toBe('expert-a')
    expect(best.matchScore).toBeGreaterThan(70)
    expect(best.matchExplanation.version).toBe(1)
    expect(best.matchExplanation.weights).toEqual(SCORE_WEIGHTS)
    expect(best.matchExplanation.matchedFilters).toContain('verified profile')
    expect(best.matchExplanation.matchedFilters).toContain('available soon')
    expect(best.matchExplanation.evidence.paidMinutes).toBe(1200)
  })

  it('applies structured availability and budget filters before ranking', () => {
    const results = rankExpertCandidates(candidates, {
      query: 'marketplace',
      availability: 'this_week',
      maxHourlyRate: 125
    })

    expect(results.map((candidate) => candidate.id)).toEqual(['expert-b'])
  })

  it('uses stable IDs to tie-break equal scores for deterministic results', () => {
    const [first, second] = rankExpertCandidates([
      { id: 'expert-b', name: 'Same', expertise: [], hourly_rate: '100' },
      { id: 'expert-a', name: 'Same', expertise: [], hourly_rate: '100' }
    ])

    expect(first.id).toBe('expert-a')
    expect(second.id).toBe('expert-b')
  })
})
