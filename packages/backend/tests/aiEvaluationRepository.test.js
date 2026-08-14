import { describe, expect, it } from 'vitest'
import { saveEvaluationExample, saveEvaluationRun, saveFeatureSnapshot, saveShadowDecision } from '../lib/aiEvaluationRepository.js'

describe('Paytray AI evaluation repository', () => {
  function clientFor(sqlFragment) {
    const calls = []
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes(sqlFragment)) return { rows: [{ id: 'saved-1', applied: false }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
  }

  it('persists point-in-time feature snapshots with parameterized JSON and UUID arrays', async () => {
    const client = clientFor('INSERT INTO ai_feature_snapshots')
    const result = await saveFeatureSnapshot(client, {
      entityType: 'expert_profile', entityId: 'profile-1', featureVersion: 'discovery-v1',
      asOf: '2026-08-14T19:00:00.000Z', features: { verified: true }, sourceEventIds: ['event-1'],
      sourceHash: 'a'.repeat(64), privacyClass: 'derived_non_content', retentionUntil: '2027-08-14T19:00:00.000Z'
    })
    expect(result.id).toBe('saved-1')
    expect(client.calls[0].sql).toContain('$5::jsonb')
    expect(client.calls[0].params[4]).toBe('{"verified":true}')
  })

  it('persists only verified-aware evaluation examples and run metadata', async () => {
    const exampleClient = clientFor('INSERT INTO ai_evaluation_examples')
    await saveEvaluationExample(exampleClient, {
      datasetVersion: 'phase3-v1', queryId: 'query-1', candidateProfileId: 'profile-1', engagementId: null,
      labelType: 'completed', labelValue: 1, labelVerificationStatus: 'verified', split: 'test',
      asOf: '2026-08-14T19:00:00.000Z', sourceEventIds: [], provenance: { source: 'verified_outcome' }
    })
    expect(exampleClient.calls[0].params[5]).toBe(1)

    const runClient = clientFor('INSERT INTO ai_evaluation_runs')
    const run = await saveEvaluationRun(runClient, {
      taskType: 'ranking', modelName: 'weighted-baseline', modelVersion: 'v1', baselineVersion: 'v1',
      datasetVersion: 'phase3-v1', timeSplit: { trainBefore: '2026-07-01', testFrom: '2026-07-01' },
      metrics: { ndcgAtK: 0.7 }, rollbackTarget: 'weighted-baseline-v1'
    })
    expect(run.id).toBe('saved-1')
  })

  it('persists shadow decisions as unapplied and not reviewed', async () => {
    const client = clientFor('INSERT INTO ai_shadow_decisions')
    const result = await saveShadowDecision(client, {
      evaluationRunId: null, taskType: 'risk_scoring', entityType: 'payment_stream', entityId: 'stream-1',
      modelVersion: 'rules-v1', inputHash: 'b'.repeat(64), output: { score: 0.2 }, confidence: 0.8, reasonCodes: ['normal']
    })
    expect(result.applied).toBe(false)
    expect(client.calls[0].sql).toContain("'not_reviewed'")
  })
})
