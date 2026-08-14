import { describe, expect, it } from 'vitest'
import { evaluateShadowQuality } from '../lib/shadowQualityGate.js'

const strongMetrics = {
  sampleCount: 100,
  baseline: { ndcgAtK: 0.62 },
  candidate: { ndcgAtK: 0.66 },
  confidence: { improvementLowerBound: 0.015 }
}

describe('shadow quality gate', () => {
  it('requires measurable improvement, confidence, rollback, sample, and human review', () => {
    const result = evaluateShadowQuality({ metrics: strongMetrics, baselineVersion: 'phase2-v1', rollbackTarget: 'phase2-v1', reviewerDecision: 'approved_pilot' })
    expect(result).toMatchObject({ eligible: true, promotionStatus: 'shadow_only', authority: 'human_review_required' })
    expect(Object.values(result.checks).every((check) => check.ready)).toBe(true)
  })

  it('blocks an unreviewed or underpowered candidate without mutating promotion state', () => {
    const result = evaluateShadowQuality({ metrics: { ...strongMetrics, sampleCount: 5 }, baselineVersion: 'phase2-v1', rollbackTarget: null, reviewerDecision: 'pending' })
    expect(result.eligible).toBe(false)
    expect(result.checks.sampleSize.ready).toBe(false)
    expect(result.checks.rollbackTarget.ready).toBe(false)
    expect(result.checks.humanReview.ready).toBe(false)
    expect(result.promotionStatus).toBe('shadow_only')
  })
})
