function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function evaluateShadowQuality({ metrics = {}, baselineVersion = null, rollbackTarget = null, reviewerDecision = 'pending', minSampleCount = 30, minImprovement = 0.01 }) {
  const baseline = metrics.baseline || {}
  const candidate = metrics.candidate || {}
  const sampleCount = finiteNumber(metrics.sampleCount)
  const baselineNdcg = finiteNumber(baseline.ndcgAtK)
  const candidateNdcg = finiteNumber(candidate.ndcgAtK)
  const improvement = baselineNdcg != null && candidateNdcg != null ? candidateNdcg - baselineNdcg : null
  const confidenceLowerBound = finiteNumber(metrics.confidence?.improvementLowerBound)
  const checks = {
    sampleSize: { ready: sampleCount != null && sampleCount >= minSampleCount, value: sampleCount, minimum: minSampleCount },
    baselineComparison: { ready: improvement != null && improvement >= minImprovement, improvement, minimum: minImprovement },
    confidence: { ready: confidenceLowerBound != null && confidenceLowerBound >= 0, improvementLowerBound: confidenceLowerBound },
    rollbackTarget: { ready: Boolean(baselineVersion && rollbackTarget), baselineVersion, rollbackTarget },
    humanReview: { ready: reviewerDecision === 'approved_pilot', reviewerDecision }
  }
  return {
    eligible: Object.values(checks).every((check) => check.ready),
    promotionStatus: 'shadow_only',
    authority: 'human_review_required',
    checks
  }
}
