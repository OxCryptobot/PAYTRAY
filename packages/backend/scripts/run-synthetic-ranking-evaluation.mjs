import { mkdir, writeFile } from 'node:fs/promises'
import { exportRankingEvaluation } from '../lib/evaluationExport.js'
import { compareRankingShadow, persistRankingShadowComparison } from '../lib/rankingShadowService.js'

const fixtures = [
  {
    impression_id: 'synthetic-impression-a-alpha', query_id: 'synthetic-query-a', candidate_profile_id: 'synthetic-profile-alpha', engagement_id: 'synthetic-engagement-alpha', observed_at: '2026-06-15T12:00:00.000Z', baseline_score: '97.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [{ id: 'synthetic-outcome-alpha-repeat', event_type: 'repeat_booking' }]
  },
  {
    impression_id: 'synthetic-impression-a-beta', query_id: 'synthetic-query-a', candidate_profile_id: 'synthetic-profile-beta', engagement_id: 'synthetic-engagement-beta', observed_at: '2026-06-15T12:00:00.000Z', baseline_score: '86.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [{ id: 'synthetic-outcome-beta-completed', event_type: 'meeting_completed' }]
  },
  {
    impression_id: 'synthetic-impression-a-gamma', query_id: 'synthetic-query-a', candidate_profile_id: 'synthetic-profile-gamma', engagement_id: null, observed_at: '2026-06-15T12:00:00.000Z', baseline_score: '77.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [], unverified_events: [{ event_type: 'meeting_completed' }]
  },
  {
    impression_id: 'synthetic-impression-b-delta', query_id: 'synthetic-query-b', candidate_profile_id: 'synthetic-profile-delta', engagement_id: 'synthetic-engagement-delta', observed_at: '2026-08-05T12:00:00.000Z', baseline_score: '94.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [{ id: 'synthetic-outcome-delta-dispute', event_type: 'dispute_opened' }]
  },
  {
    impression_id: 'synthetic-impression-b-epsilon', query_id: 'synthetic-query-b', candidate_profile_id: 'synthetic-profile-epsilon', engagement_id: 'synthetic-engagement-epsilon', observed_at: '2026-08-05T12:00:00.000Z', baseline_score: '83.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [{ id: 'synthetic-outcome-epsilon-completed', event_type: 'meeting_completed' }]
  },
  {
    impression_id: 'synthetic-impression-c-zeta', query_id: 'synthetic-query-c', candidate_profile_id: 'synthetic-profile-zeta', engagement_id: 'synthetic-engagement-zeta', observed_at: '2026-07-15T12:00:00.000Z', baseline_score: '89.0', ranking_version: 'weighted-explainable-v1',
    verified_events: [{ id: 'synthetic-outcome-zeta-completed', event_type: 'meeting_completed' }]
  },
  {
    impression_id: 'synthetic-impression-c-eta', query_id: 'synthetic-query-c', candidate_profile_id: 'synthetic-profile-eta', engagement_id: null, observed_at: '2026-07-15T12:00:00.000Z', baseline_score: '81.0', ranking_version: 'weighted-explainable-v1',
    verified_events: []
  }
]

const calls = []
const client = {
  async query(sql, params = []) {
    calls.push({ sql, params })
    if (sql.includes('FROM discovery_impressions')) return { rows: fixtures }
    if (sql.includes('INSERT INTO ai_evaluation_examples')) return { rows: [{ id: `synthetic-example-${calls.length}` }] }
    if (sql.includes('INSERT INTO ai_evaluation_runs')) return { rows: [{ id: 'synthetic-run-1' }] }
    if (sql.includes('INSERT INTO ai_shadow_decisions')) return { rows: [{ id: `synthetic-decision-${calls.length}`, applied: false }] }
    throw new Error(`Unexpected synthetic query: ${sql}`)
  }
}

const datasetVersion = 'phase3-ranking-synthetic-v1'
const exportResult = await exportRankingEvaluation({
  client,
  datasetVersion,
  trainBefore: '2026-07-01T00:00:00.000Z',
  validationBefore: '2026-08-01T00:00:00.000Z',
  asOf: '2026-08-14T23:59:59.000Z'
})

const eligible = exportResult.examples.filter((example) => example.labelVerificationStatus === 'verified' && example.split !== 'shadow')
const comparison = compareRankingShadow({
  examples: eligible,
  candidateVersion: 'phase3-shadow-candidate-mock-v1',
  candidateRanker: (query) => [...query.baselineRankedIds].sort((left, right) => query.relevanceById[right] - query.relevanceById[left])
})
const persisted = await persistRankingShadowComparison({
  client,
  comparison,
  datasetVersion,
  timeSplit: { trainBefore: '2026-07-01T00:00:00.000Z', validationBefore: '2026-08-01T00:00:00.000Z', asOf: '2026-08-14T23:59:59.000Z' },
  limitations: 'Synthetic fixture only; candidate is a deterministic relevance-sort harness, not a trained model.'
})

const report = {
  source: 'synthetic_mock_fixture',
  warning: 'These metrics validate pipeline behavior only. They are not evidence of production ranking quality.',
  datasetVersion,
  fixtureRows: fixtures.length,
  exportedExamples: exportResult.exampleCount,
  verifiedExamples: exportResult.verifiedExampleCount,
  shadowExamples: exportResult.shadowExampleCount,
  eligibleExamples: eligible.length,
  unverifiedFixtureEventsIgnored: fixtures.reduce((count, row) => count + (row.unverified_events?.length || 0), 0),
  comparison: {
    baseline: comparison.baselineMetrics,
    candidate: comparison.candidateMetrics,
    delta: comparison.delta,
    promotionStatus: comparison.promotionStatus,
    applied: comparison.applied
  },
  persistence: {
    evaluationRunId: persisted.run.id,
    shadowDecisionCount: persisted.decisionCount,
    applied: persisted.applied,
    sqlCallCount: calls.length
  }
}

await mkdir('docs/evidence', { recursive: true })
await writeFile('docs/evidence/phase3-synthetic-ranking-evaluation.json', `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
