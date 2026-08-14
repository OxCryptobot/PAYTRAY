import { closeDatabase, initializeDatabase, transaction } from '../lib/database.js'
import { exportRankingEvaluation } from '../lib/evaluationExport.js'
import { ingestTelemetryEvent } from '../lib/telemetryService.js'
import { compareRankingShadow, persistRankingShadowComparison } from '../lib/rankingShadowService.js'

const asOf = process.env.EVAL_AS_OF || new Date().toISOString()
const trainBefore = process.env.EVAL_TRAIN_BEFORE || '2026-07-01T00:00:00.000Z'
const validationBefore = process.env.EVAL_VALIDATION_BEFORE || '2026-08-01T00:00:00.000Z'
const datasetVersion = process.env.EVAL_DATASET_VERSION || 'phase3-ranking-v1'

try {
  await initializeDatabase()
  const exported = await transaction((client) => exportRankingEvaluation({
    client,
    datasetVersion,
    trainBefore,
    validationBefore,
    asOf
  }))

  const eligible = exported.examples.filter((example) => example.labelVerificationStatus === 'verified' && example.split !== 'shadow')
  const comparison = compareRankingShadow({
    examples: eligible,
    baselineVersion: 'weighted-explainable-v1',
    candidateVersion: 'phase3-shadow-candidate-v0'
  })
  const persisted = await transaction((client) => persistRankingShadowComparison({
    client,
    comparison,
    datasetVersion,
    timeSplit: { trainBefore, validationBefore, asOf }
  }))
  await transaction((client) => ingestTelemetryEvent({
    client,
    event: {
      eventId: `shadow-evaluation:${datasetVersion}:${asOf}`,
      eventType: 'shadow_evaluation_completed',
      occurredAt: new Date().toISOString(),
      actorScope: 'evaluation_worker',
      entityType: 'expert_profile',
      entityId: datasetVersion,
      schemaVersion: '1',
      source: 'ranking-shadow-worker',
      privacyClass: 'operational',
      payload: {
        datasetVersion,
        exportedExamples: exported.exampleCount,
        verifiedExamples: exported.verifiedExampleCount,
        eligibleExamples: eligible.length,
        queryCount: comparison.queryCount,
        delta: comparison.delta,
        promotionStatus: comparison.promotionStatus,
        applied: persisted.applied
      },
      provenance: { evaluationRunId: persisted.run.id, baselineVersion: comparison.baselineVersion, candidateVersion: comparison.candidateVersion }
    }
  }))

  console.log(JSON.stringify({
    status: 'ok',
    datasetVersion,
    asOf,
    exportedExamples: exported.exampleCount,
    verifiedExamples: exported.verifiedExampleCount,
    shadowExamples: exported.shadowExampleCount,
    eligibleExamples: eligible.length,
    comparison: {
      queryCount: comparison.queryCount,
      baseline: comparison.baselineMetrics,
      candidate: comparison.candidateMetrics,
      delta: comparison.delta,
      promotionStatus: comparison.promotionStatus
    },
    evaluationRunId: persisted.run.id,
    shadowDecisionCount: persisted.decisionCount,
    applied: persisted.applied
  }, null, 2))
} finally {
  await closeDatabase()
}
