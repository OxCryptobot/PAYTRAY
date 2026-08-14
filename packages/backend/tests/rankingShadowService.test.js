import { describe, expect, it } from 'vitest'
import { compareRankingShadow, groupExamples } from '../lib/rankingShadowService.js'

describe('Paytray ranking shadow comparison', () => {
  const examples = [
    { queryId: 'q1', candidateProfileId: 'a', labelValue: 2, provenance: { baselineScore: 90 } },
    { queryId: 'q1', candidateProfileId: 'b', labelValue: 0, provenance: { baselineScore: 80 } },
    { queryId: 'q1', candidateProfileId: 'c', labelValue: 1, provenance: { baselineScore: 70 } },
    { queryId: 'q2', candidateProfileId: 'x', labelValue: 0, provenance: { baselineScore: 90 } },
    { queryId: 'q2', candidateProfileId: 'y', labelValue: 2, provenance: { baselineScore: 80 } }
  ]

  it('groups examples by query and preserves baseline score ordering', () => {
    const grouped = groupExamples(examples)
    expect(grouped).toHaveLength(2)
    expect(grouped[0].baselineRankedIds).toEqual(['a', 'b', 'c'])
  })

  it('keeps the Phase 2 baseline unchanged when the candidate is the baseline', () => {
    const comparison = compareRankingShadow({ examples, candidateVersion: 'candidate-v0' })
    expect(comparison.baselineMetrics.ndcgAtK).toBe(comparison.candidateMetrics.ndcgAtK)
    expect(comparison.delta).toEqual({ precisionAtK: 0, recallAtK: 0, ndcgAtK: 0 })
    expect(comparison.promotionStatus).toBe('shadow_only')
    expect(comparison.applied).toBe(false)
  })

  it('reports improvement without applying candidate ordering', () => {
    const comparison = compareRankingShadow({
      examples,
      candidateRanker: (query) => [...query.baselineRankedIds].sort((left, right) => {
        const relevance = query.relevanceById
        return relevance[right] - relevance[left]
      }),
      candidateVersion: 'candidate-v1'
    })
    expect(comparison.candidateMetrics.ndcgAtK).toBeGreaterThan(comparison.baselineMetrics.ndcgAtK)
    expect(comparison.delta.ndcgAtK).toBeGreaterThan(0)
    expect(comparison.promotionStatus).toBe('shadow_only')
    expect(comparison.applied).toBe(false)
  })
})
