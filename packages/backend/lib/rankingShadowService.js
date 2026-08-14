import { evaluateRankingQueries, createShadowDecision } from './aiEvaluation.js'
import { saveEvaluationRun, saveShadowDecision } from './aiEvaluationRepository.js'

function groupExamples(examples) {
  const grouped = new Map()
  for (const example of examples) {
    if (!grouped.has(example.queryId)) grouped.set(example.queryId, [])
    grouped.get(example.queryId).push(example)
  }
  return [...grouped.entries()].map(([queryId, queryExamples]) => {
    const relevanceById = Object.fromEntries(queryExamples.map((example) => [example.candidateProfileId, example.labelValue]))
    const baselineRankedIds = [...queryExamples]
      .sort((left, right) => Number(right.provenance.baselineScore || 0) - Number(left.provenance.baselineScore || 0))
      .map((example) => example.candidateProfileId)
    return { queryId, relevanceById, baselineRankedIds, examples: queryExamples }
  })
}

export function compareRankingShadow({ examples, candidateRanker = (query) => query.baselineRankedIds, k = 3, baselineVersion = 'weighted-explainable-v1', candidateVersion = 'phase3-shadow-candidate-v0' }) {
  const grouped = groupExamples(examples)
  const baselineQueries = grouped.map((query) => ({ queryId: query.queryId, rankedIds: query.baselineRankedIds, relevanceById: query.relevanceById }))
  const candidateQueries = grouped.map((query) => ({ queryId: query.queryId, rankedIds: candidateRanker(query), relevanceById: query.relevanceById }))
  const baselineMetrics = evaluateRankingQueries(baselineQueries, k)
  const candidateMetrics = evaluateRankingQueries(candidateQueries, k)
  const delta = {
    precisionAtK: Number((candidateMetrics.precisionAtK - baselineMetrics.precisionAtK).toFixed(6)),
    recallAtK: Number((candidateMetrics.recallAtK - baselineMetrics.recallAtK).toFixed(6)),
    ndcgAtK: Number((candidateMetrics.ndcgAtK - baselineMetrics.ndcgAtK).toFixed(6))
  }
  return {
    baselineVersion,
    candidateVersion,
    k,
    queryCount: grouped.length,
    baselineMetrics,
    candidateMetrics,
    delta,
    promotionStatus: 'shadow_only',
    applied: false,
    queries: grouped.map((query, index) => ({
      queryId: query.queryId,
      baselineRankedIds: baselineQueries[index].rankedIds,
      candidateRankedIds: candidateQueries[index].rankedIds,
      examples: query.examples
    }))
  }
}

export async function persistRankingShadowComparison({ client, comparison, datasetVersion, timeSplit, limitations = 'Candidate remains a no-op shadow harness until a trained model is approved.' }) {
  const run = await saveEvaluationRun(client, {
    taskType: 'ranking',
    modelName: 'phase3-ranking-shadow',
    modelVersion: comparison.candidateVersion,
    baselineVersion: comparison.baselineVersion,
    datasetVersion,
    timeSplit,
    metrics: {
      baseline: comparison.baselineMetrics,
      candidate: comparison.candidateMetrics,
      delta: comparison.delta,
      promotionStatus: comparison.promotionStatus
    },
    status: 'shadow',
    reviewerDecision: 'pending',
    rollbackTarget: comparison.baselineVersion,
    limitations
  })

  let decisionCount = 0
  for (const query of comparison.queries) {
    for (const [candidateRank, profileId] of query.candidateRankedIds.entries()) {
      const baselineRank = query.baselineRankedIds.indexOf(profileId)
      const decision = createShadowDecision({
        evaluationRunId: run.id,
        taskType: 'ranking',
        entityType: 'expert_profile',
        entityId: profileId,
        modelVersion: comparison.candidateVersion,
        input: { datasetVersion, queryId: query.queryId, baselineVersion: comparison.baselineVersion },
        output: { queryId: query.queryId, baselineRank: baselineRank < 0 ? null : baselineRank + 1, candidateRank: candidateRank + 1 },
        reasonCodes: ['shadow_only', comparison.delta.ndcgAtK > 0 ? 'candidate_ndcg_improvement' : 'baseline_retained']
      })
      await saveShadowDecision(client, decision)
      decisionCount += 1
    }
  }
  return { run, decisionCount, applied: false, promotionStatus: 'shadow_only' }
}

export { groupExamples }
