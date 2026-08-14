import { describe, expect, it } from 'vitest'
import { buildEvaluationExample, splitForTimestamp } from '../lib/evaluationExport.js'

describe('Paytray versioned evaluation export', () => {
  it('assigns deterministic temporal splits', () => {
    expect(splitForTimestamp('2026-06-01T00:00:00.000Z', { trainBefore: '2026-07-01', validationBefore: '2026-08-01' })).toBe('train')
    expect(splitForTimestamp('2026-07-15T00:00:00.000Z', { trainBefore: '2026-07-01', validationBefore: '2026-08-01' })).toBe('validation')
    expect(splitForTimestamp('2026-08-15T00:00:00.000Z', { trainBefore: '2026-07-01', validationBefore: '2026-08-01' })).toBe('test')
  })

  it('exports verified completion evidence into an eligible split', () => {
    const example = buildEvaluationExample({
      impression_id: 'impression-1',
      query_id: 'query-1',
      candidate_profile_id: 'profile-1',
      engagement_id: 'engagement-1',
      observed_at: '2026-07-15T00:00:00.000Z',
      baseline_score: '91.2',
      ranking_version: 'weighted-explainable-v1',
      verified_events: [{ id: 'outcome-1', event_type: 'meeting_completed' }]
    }, {
      datasetVersion: 'phase3-ranking-v1',
      trainBefore: '2026-07-01',
      validationBefore: '2026-08-01'
    })

    expect(example.labelType).toBe('completed')
    expect(example.labelValue).toBe(2)
    expect(example.labelVerificationStatus).toBe('verified')
    expect(example.split).toBe('validation')
    expect(example.sourceEventIds).toEqual(['outcome-1'])
    expect(example.provenance.baselineScore).toBe('91.2')
  })

  it('keeps missing verified evidence in shadow instead of inventing a negative label', () => {
    const example = buildEvaluationExample({
      impression_id: 'impression-2',
      query_id: 'query-1',
      candidate_profile_id: 'profile-2',
      engagement_id: null,
      observed_at: '2026-07-15T00:00:00.000Z',
      baseline_score: '80.1',
      ranking_version: 'weighted-explainable-v1',
      verified_events: []
    }, {
      datasetVersion: 'phase3-ranking-v1',
      trainBefore: '2026-07-01',
      validationBefore: '2026-08-01'
    })

    expect(example.labelValue).toBe(0)
    expect(example.labelVerificationStatus).toBe('unverified')
    expect(example.split).toBe('shadow')
  })
})
