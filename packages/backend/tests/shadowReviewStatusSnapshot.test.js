import { describe, expect, it } from 'vitest'
import { buildShadowReviewStatusSnapshot } from '../lib/shadowReviewStatusSnapshot.js'

const expected = ['run-pending', 'run-approved', 'run-rejected']

const runs = [
  { id: 'run-pending', status: 'shadow', reviewer_decision: 'pending', reviewer_id: null, reviewed_at: null, model_name: 'shadow', model_version: 'v1', baseline_version: 'b1', dataset_version: 'd1', rollback_target: 'b1' },
  { id: 'run-approved', status: 'shadow', reviewer_decision: 'approved_pilot', reviewer_id: '0xreviewer', reviewed_at: '2026-08-16T00:00:00.000Z', model_name: 'shadow', model_version: 'v1', baseline_version: 'b1', dataset_version: 'd1', rollback_target: 'b1' },
  { id: 'run-rejected', status: 'shadow', reviewer_decision: 'rejected', reviewer_id: '0xreviewer', reviewed_at: '2026-08-16T00:00:00.000Z', model_name: 'shadow', model_version: 'v1', baseline_version: 'b1', dataset_version: 'd1', rollback_target: 'b1' }
]

describe('shadow review status snapshot', () => {
  it('reports pending human review without mutation authority', () => {
    expect(buildShadowReviewStatusSnapshot({ runs, expectedRunIds: expected })).toMatchObject({
      status: 'pending_human_review',
      expectedRunCount: 3,
      observedRunCount: 3,
      pendingCount: 1,
      terminalCount: 2,
      missingRunIds: [],
      submissionPerformed: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    })
  })

  it('reports incomplete expected-run coverage', () => {
    expect(buildShadowReviewStatusSnapshot({ runs: runs.slice(0, 2), expectedRunIds: expected })).toMatchObject({ status: 'incomplete', missingRunIds: ['run-rejected'] })
  })

  it('reports complete only when no pending reviews remain', () => {
    expect(buildShadowReviewStatusSnapshot({ runs: runs.slice(1), expectedRunIds: ['run-approved', 'run-rejected'] })).toMatchObject({ status: 'complete', pendingCount: 0, terminalCount: 2 })
  })
})
