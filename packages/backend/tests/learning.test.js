import { describe, it, expect } from 'vitest'
import { SelfLearningRanker, FEATURES, normalizeWeights } from '../lib/learning.js'

const PRIOR = {
  skillMatch: 0.3,
  budgetScore: 0.15,
  timezoneScore: 0.1,
  languageScore: 0.1,
  chainScore: 0.1,
  completionRate: 0.15,
  outcomeHistoryBoost: 0.1
}

function rng(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function sample(random, truth) {
  const features = Object.fromEntries(FEATURES.map((name) => [name, random() > 0.5 ? 1 : 0]))
  const label = truth(features) ? 1 : 0
  return { features, label }
}

describe('SelfLearningRanker', () => {
  it('keeps live weights normalized and equal to the prior before evidence', () => {
    const learner = new SelfLearningRanker(PRIOR)
    const weights = learner.getWeights()
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4)
    expect(weights.skillMatch).toBeCloseTo(0.3, 3)
  })

  it('learns that completion history, not skill match, drives outcomes', () => {
    const learner = new SelfLearningRanker(PRIOR)
    const random = rng(7)
    for (let i = 0; i < 600; i += 1) {
      const { features, label } = sample(random, (f) => f.completionRate === 1)
      learner.observe(features, label)
    }
    const weights = learner.getWeights()
    expect(learner.status().version).toBeGreaterThan(0)
    expect(weights.completionRate).toBeGreaterThan(PRIOR.completionRate * 1.5)
    expect(weights.completionRate).toBeGreaterThan(weights.skillMatch)
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3)
  })

  it('adapts after the world changes (drift) and can roll back manually', () => {
    const learner = new SelfLearningRanker(PRIOR)
    const random = rng(11)
    for (let i = 0; i < 500; i += 1) {
      const { features, label } = sample(random, (f) => f.completionRate === 1)
      learner.observe(features, label)
    }
    const beforeShift = learner.getWeights()
    for (let i = 0; i < 1200; i += 1) {
      const { features, label } = sample(random, (f) => f.skillMatch === 1)
      learner.observe(features, label)
    }
    const after = learner.getWeights()
    expect(after.skillMatch).toBeGreaterThan(beforeShift.skillMatch)
    expect(after.skillMatch).toBeGreaterThan(after.completionRate)

    const version = learner.status().version
    expect(learner.rollback()).toBe(true)
    expect(learner.status().version).toBe(version + 1)
  })

  it('rollback returns false when no history exists', () => {
    expect(new SelfLearningRanker(PRIOR).rollback()).toBe(false)
  })

  it('gives under-observed experts a larger, bounded exploration bonus', () => {
    const learner = new SelfLearningRanker(PRIOR)
    const fresh = learner.explorationBonus(0, 100)
    const seasoned = learner.explorationBonus(50, 100)
    expect(fresh).toBeGreaterThan(seasoned)
    expect(fresh).toBeLessThanOrEqual(8)
  })

  it('survives a serialize/restore round trip and ignores corrupt snapshots', () => {
    const learner = new SelfLearningRanker(PRIOR)
    const random = rng(3)
    for (let i = 0; i < 200; i += 1) {
      const { features, label } = sample(random, (f) => f.budgetScore === 1)
      learner.observe(features, label)
    }
    const clone = new SelfLearningRanker(PRIOR)
    clone.restore(JSON.parse(JSON.stringify(learner.toJSON())))
    expect(clone.getWeights()).toEqual(learner.getWeights())
    expect(clone.status().samples).toBe(learner.status().samples)

    const intact = new SelfLearningRanker(PRIOR)
    intact.restore({ shadow: 'bad' })
    expect(intact.status().samples).toBe(0)
  })

  it('normalizeWeights enforces a floor and unit sum', () => {
    const weights = normalizeWeights({ skillMatch: 5, budgetScore: -1 })
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4)
    expect(Math.min(...Object.values(weights))).toBeGreaterThan(0)
  })
})

describe('SelfLearningRanker extensions', () => {
  it('supports custom feature sets and a base-rate bias for risk modeling', () => {
    const risk = new SelfLearningRanker({ a: 1, b: 1 }, { features: ['a', 'b'], initialBias: -2.2, seedScale: 3 })
    expect(risk.predictLive({ a: 0, b: 0 })).toBeLessThan(0.15)
    const random = rng(5)
    for (let i = 0; i < 800; i += 1) {
      const a = random() > 0.5 ? 1 : 0
      risk.observe({ a, b: random() > 0.5 ? 1 : 0 }, a)
    }
    expect(risk.predictLive({ a: 1, b: 0 })).toBeGreaterThan(risk.predictLive({ a: 0, b: 1 }))
    expect(risk.trust()).toBeGreaterThan(0.9)
  })

  it('inverse-propensity weights make rare observations move the model more', () => {
    const plain = new SelfLearningRanker(PRIOR)
    const weighted = new SelfLearningRanker(PRIOR)
    const features = { skillMatch: 1 }
    for (let i = 0; i < 5; i += 1) {
      plain.observe(features, 1)
      weighted.observe(features, 1, undefined, { weight: 4 })
    }
    expect(weighted.predict(features)).toBeGreaterThan(plain.predict(features))
  })

  it('self-review reports staleness and handles empty models', () => {
    const learner = new SelfLearningRanker(PRIOR)
    expect(learner.review().decision).toBe('no_data')
    learner.observe({ skillMatch: 1 }, 1, '2020-01-01T00:00:00.000Z')
    const review = learner.review('2020-02-01T00:00:00.000Z')
    expect(review.stale).toBe(true)
    expect(review.decision).toBe('no_new_data')
    expect(learner.review('2020-01-01T00:00:01.000Z').stale).toBe(false)
  })
})
