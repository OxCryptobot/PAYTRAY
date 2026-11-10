// Experimental online model. Its outcomes are not independently verified and
// its internal promotion decisions are not used for production decisions.

export const FEATURES = Object.freeze([
  'skillMatch',
  'budgetScore',
  'timezoneScore',
  'languageScore',
  'chainScore',
  'completionRate',
  'outcomeHistoryBoost'
])

const DEFAULTS = Object.freeze({
  initialBias: 0,
  seedScale: 4,
  staleAfterMs: 7 * 24 * 3600 * 1000,
  maxWeight: 10,
  learningRate: 0.15,
  l2: 0.001,
  lossDecay: 0.05,
  minSamplesForPromotion: 20,
  promotionMargin: 0.005,
  rollbackMargin: 0.08,
  priorStrength: 25,
  explorationWeight: 6,
  maxExplorationBonus: 8,
  historyLimit: 20
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)))
const round = (value, digits = 4) => Number(value.toFixed(digits))

function logLoss(p, label) {
  const eps = 1e-6
  const q = clamp(p, eps, 1 - eps)
  return -(label * Math.log(q) + (1 - label) * Math.log(1 - q))
}

function vectorize(features, names) {
  return names.map((name) => clamp(Number(features?.[name]) || 0, 0, 1))
}

export function normalizeWeights(raw, names = FEATURES, floor = 0.02) {
  const clipped = names.map((name) => Math.max(floor, Number(raw?.[name]) || 0))
  const total = clipped.reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(names.map((name, index) => [name, round(clipped[index] / total, 6)]))
}

function newModel(weightsByFeature, names, bias) {
  return { w: names.map((name) => Number(weightsByFeature?.[name]) || 0), b: bias, n: 0 }
}

function predictWith(model, x) {
  return sigmoid(model.w.reduce((sum, weight, index) => sum + weight * x[index], model.b))
}

export class SelfLearningRanker {
  constructor(priorWeights, options = {}) {
    this.options = { ...DEFAULTS, ...options }
    this.features = Array.isArray(options.features) ? options.features : FEATURES
    this.priorWeights = normalizeWeights(priorWeights, this.features)
    this.reset()
  }

  reset() {
    // Shadow starts from prior direction scaled so logits are meaningful; live is the served model.
    const { seedScale, initialBias } = this.options
    const seed = Object.fromEntries(this.features.map((name) => [name, this.priorWeights[name] * seedScale]))
    this.shadow = newModel(seed, this.features, initialBias)
    this.live = newModel(seed, this.features, initialBias)
    this.liveWeights = { ...this.priorWeights }
    this.stats = { samples: 0, positives: 0, liveLoss: null, shadowLoss: null, bestLiveLoss: null }
    this.version = 0
    this.history = []
    this.events = []
    this.lastUpdatedAt = null
  }

  getWeights() {
    return { ...this.liveWeights }
  }

  // Learn from a single observed outcome. Returns what happened for observability.
  // Optional sample weight; an estimated propensity alone does not remove selection bias.
  observe(features, label, now = new Date().toISOString(), { weight = 1 } = {}) {
    const x = vectorize(features, this.features)
    const sampleWeight = clamp(Number(weight) || 1, 0.1, this.options.maxWeight)
    const y = label ? 1 : 0
    const { lossDecay, learningRate, l2 } = this.options

    const liveLoss = logLoss(predictWith(this.live, x), y)
    const shadowLoss = logLoss(predictWith(this.shadow, x), y)
    const ewma = (previous, value) => (previous === null ? value : previous * (1 - lossDecay) + value * lossDecay)
    this.stats.liveLoss = ewma(this.stats.liveLoss, liveLoss)
    this.stats.shadowLoss = ewma(this.stats.shadowLoss, shadowLoss)
    this.stats.samples += 1
    this.stats.positives += y

    // The experimental champion is frozen between promotions.
    const error = predictWith(this.shadow, x) - y
    const step = (learningRate * sampleWeight) / Math.sqrt(1 + this.shadow.n / 50)
    this.shadow.w = this.shadow.w.map((weight, index) => weight - step * (error * x[index] + l2 * weight))
    this.shadow.b -= step * error
    this.shadow.n += 1
    this.lastUpdatedAt = now

    const decision = this.#govern(now)
    return { liveLoss: round(liveLoss), shadowLoss: round(shadowLoss), decision }
  }

  #govern(now) {
    const { minSamplesForPromotion, promotionMargin, rollbackMargin } = this.options
    const { liveLoss, shadowLoss } = this.stats

    if (this.stats.bestLiveLoss === null || liveLoss < this.stats.bestLiveLoss) {
      this.stats.bestLiveLoss = liveLoss
    }

    if (this.stats.samples < minSamplesForPromotion) return 'warming_up'

    // Drift: served model has degraded well beyond its best state and the shadow is healthier.
    if (liveLoss - this.stats.bestLiveLoss > rollbackMargin && shadowLoss < liveLoss) {
      const target = this.history.length > 0 ? this.history[this.history.length - 1] : null
      if (target) {
        this.#adopt(target.weights, now, 'drift_rollback')
        return 'drift_rollback'
      }
      this.#promote(now, 'drift_recovery')
      return 'drift_recovery'
    }

    if (liveLoss - shadowLoss > promotionMargin) {
      this.#promote(now, 'challenger_won')
      return 'promoted'
    }
    return 'hold'
  }

  #promote(now, reason) {
    // Shrink toward the prior with few samples; trust learned weights as evidence grows.
    const trust = this.stats.samples / (this.stats.samples + this.options.priorStrength)
    const learned = normalizeWeights(Object.fromEntries(this.features.map((name, index) => [name, this.shadow.w[index]])))
    const blended = Object.fromEntries(
      this.features.map((name) => [name, trust * learned[name] + (1 - trust) * this.priorWeights[name]])
    )
    this.live = { w: [...this.shadow.w], b: this.shadow.b, n: this.shadow.n }
    this.#adopt(normalizeWeights(blended, this.features), now, reason, true)
    this.stats.bestLiveLoss = this.stats.shadowLoss
    this.stats.liveLoss = this.stats.shadowLoss
  }

  #adopt(weights, now, reason, alreadySetLive = false) {
    this.history.push({ version: this.version, weights: { ...this.liveWeights }, retiredAt: now })
    if (this.history.length > this.options.historyLimit) this.history.shift()
    this.liveWeights = { ...weights }
    this.version += 1
    if (!alreadySetLive) {
      this.live = { w: this.features.map((name) => this.liveWeights[name] * this.options.seedScale), b: this.live.b, n: this.live.n }
      this.stats.liveLoss = this.stats.shadowLoss
      this.stats.bestLiveLoss = this.stats.liveLoss
    }
    this.events.push({ at: now, reason, version: this.version, weights: { ...this.liveWeights } })
    if (this.events.length > this.options.historyLimit) this.events.shift()
  }

  rollback(now = new Date().toISOString()) {
    const target = this.history[this.history.length - 1]
    if (!target) return false
    this.history.pop()
    this.liveWeights = { ...target.weights }
    this.live = { w: this.features.map((name) => this.liveWeights[name] * this.options.seedScale), b: this.live.b, n: this.live.n }
    this.version += 1
    this.stats.bestLiveLoss = this.stats.liveLoss
    this.events.push({ at: now, reason: 'manual_rollback', version: this.version, weights: { ...this.liveWeights } })
    return true
  }

  // UCB-style bonus (in score points) for experts with little outcome evidence.
  explorationBonus(expertEvents, totalEvents) {
    const { explorationWeight, maxExplorationBonus } = this.options
    const bonus = explorationWeight * Math.sqrt(Math.log(totalEvents + 2) / (expertEvents + 1))
    return round(Math.min(maxExplorationBonus, bonus), 2)
  }

  predict(features) {
    return round(predictWith(this.shadow, vectorize(features, this.features)))
  }

  // Probability from the governed (served) model, not the experimental shadow.
  predictLive(features) {
    return round(predictWith(this.live, vectorize(features, this.features)))
  }

  // Confidence in learned behavior: 0 with no data, approaching 1 with evidence.
  trust(k = this.options.priorStrength) {
    return this.stats.samples / (this.stats.samples + k)
  }

  // A review without new observations cannot provide evidence for another model change.
  review(now = new Date().toISOString()) {
    const decision = this.stats.samples > 0 ? 'no_new_data' : 'no_data'
    const age = this.lastUpdatedAt ? Date.parse(now) - Date.parse(this.lastUpdatedAt) : null
    return { decision, stale: age !== null && age > this.options.staleAfterMs, ageMs: age, samples: this.stats.samples }
  }

  status() {
    const { samples, positives, liveLoss, shadowLoss } = this.stats
    return {
      version: this.version,
      samples,
      positiveRate: samples ? round(positives / samples) : 0,
      liveLoss: liveLoss === null ? null : round(liveLoss),
      shadowLoss: shadowLoss === null ? null : round(shadowLoss),
      liveWeights: this.getWeights(),
      priorWeights: { ...this.priorWeights },
      recentEvents: this.events.slice(-5),
      rollbackDepth: this.history.length,
      lastUpdatedAt: this.lastUpdatedAt
    }
  }

  toJSON() {
    return {
      shadow: this.shadow,
      live: this.live,
      liveWeights: this.liveWeights,
      stats: this.stats,
      version: this.version,
      history: this.history,
      events: this.events,
      lastUpdatedAt: this.lastUpdatedAt
    }
  }

  restore(data) {
    if (!data || typeof data !== 'object') return
    const validModel = (m) => m && Array.isArray(m.w) && m.w.length === this.features.length && m.w.every(Number.isFinite) && Number.isFinite(m.b)
    if (!validModel(data.shadow) || !validModel(data.live) || !data.liveWeights) return
    if (!this.features.every((name) => Number.isFinite(data.liveWeights[name]))) return
    this.shadow = data.shadow
    this.live = data.live
    this.liveWeights = { ...data.liveWeights }
    this.stats = { ...this.stats, ...data.stats }
    this.version = Number(data.version) || 0
    this.history = Array.isArray(data.history) ? data.history : []
    this.events = Array.isArray(data.events) ? data.events : []
    this.lastUpdatedAt = data.lastUpdatedAt || null
  }
}

export default SelfLearningRanker
