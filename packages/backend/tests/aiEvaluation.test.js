import { describe, expect, it } from 'vitest'
import {
  AiEvaluationError,
  createEvaluationExample,
  createFeatureSnapshot,
  createShadowDecision,
  evaluateRankingQueries,
  hashStructuredInput
} from '../lib/aiEvaluation.js'

describe('Paytray AI evaluation foundation', () => {
  it('hashes structured input deterministically regardless of object key order', () => {
    expect(hashStructuredInput({ b: 2, a: 1 })).toBe(hashStructuredInput({ a: 1, b: 2 }))
  })

  it('creates a point-in-time feature snapshot without raw collaboration content', () => {
    const snapshot = createFeatureSnapshot({
      entityType: 'expert_profile',
      entityId: 'profile-1',
      featureVersion: 'discovery-v1',
      asOf: '2026-08-14T19:00:00.000Z',
      features: { completionRate: 0.96, paidMinutes: 1200, verified: true },
      sourceEventIds: ['outcome-1'],
      retentionUntil: '2027-08-14T19:00:00.000Z'
    })

    expect(snapshot.sourceHash).toHaveLength(64)
    expect(snapshot.sourceEventIds).toEqual(['outcome-1'])
    expect(() => createFeatureSnapshot({
      entityType: 'conversation',
      entityId: 'conversation-1',
      featureVersion: 'assistant-v1',
      asOf: '2026-08-14T19:00:00.000Z',
      features: { transcript: 'private content' },
      retentionUntil: '2027-08-14T19:00:00.000Z'
    })).toThrow(AiEvaluationError)
  })

  it('keeps unverified labels in shadow only', () => {
    expect(() => createEvaluationExample({
      datasetVersion: 'phase3-v1',
      queryId: 'query-1',
      candidateProfileId: 'profile-1',
      labelType: 'selected',
      labelValue: 1,
      labelVerificationStatus: 'unverified',
      split: 'train',
      asOf: '2026-08-14T19:00:00.000Z'
    })).toThrow('shadow split')

    const example = createEvaluationExample({
      datasetVersion: 'phase3-v1',
      queryId: 'query-1',
      candidateProfileId: 'profile-1',
      labelType: 'completed',
      labelValue: 1,
      labelVerificationStatus: 'verified',
      split: 'test',
      asOf: '2026-08-14T19:00:00.000Z',
      sourceEventIds: ['outcome-1']
    })
    expect(example.labelVerificationStatus).toBe('verified')
  })

  it('creates a non-applied shadow decision with input provenance', () => {
    const decision = createShadowDecision({
      taskType: 'ranking',
      entityType: 'expert_profile',
      entityId: 'profile-1',
      modelVersion: 'weighted-baseline-v1',
      input: { queryId: 'query-1', features: { verified: true } },
      output: { score: 0.8, reasonCodes: ['verified'] },
      confidence: 0.8,
      reasonCodes: ['verified']
    })

    expect(decision.inputHash).toHaveLength(64)
    expect(decision.applied).toBe(false)
    expect(decision.humanReviewStatus).toBe('not_reviewed')
  })

  it('computes reproducible ranking metrics against a relevance map', () => {
    const metrics = evaluateRankingQueries([
      { queryId: 'query-1', rankedIds: ['a', 'b', 'c'], relevanceById: { a: 1, b: 0, c: 1 } },
      { queryId: 'query-2', rankedIds: ['c', 'b', 'a'], relevanceById: { a: 0, b: 1, c: 1 } }
    ], 2)

    expect(metrics.queryCount).toBe(2)
    expect(metrics.precisionAtK).toBe(0.75)
    expect(metrics.recallAtK).toBe(0.75)
    expect(metrics.ndcgAtK).toBeGreaterThan(0.8)
  })
})
