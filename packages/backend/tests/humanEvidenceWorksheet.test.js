import { describe, expect, it } from 'vitest'
import { validateHumanEvidenceWorksheet } from '../scripts/verify-human-evidence-worksheet.mjs'

const runIds = [
  'd9280263-932b-45b0-a173-ed3e7e2dcb3c',
  '5d85ded6-4842-4091-85f3-8046e90c7b79',
  'eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49',
  '3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a',
  'c25b2bee-4fac-4f87-acf3-00541a093030',
  '7b0f934d-8bda-4b10-aa4c-d7fc019078e4'
]
const roles = ['release_operator', 'protocol_finance', 'ai_data', 'security']

function worksheet() {
  return {
    signoffs: roles.map((role) => ({ role, approved: true, reviewerId: `${role}-real`, approvedAt: '2026-08-16T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true, evidenceReviewed: 'protected evidence bundle and verified release artifact', rollbackTarget: 'immutable rollback commit abc123', notes: 'Real reviewer rationale recorded outside the repository.' })),
    shadowReviews: runIds.map((runId) => ({ runId, decision: 'rejected', reviewerId: '0xrealreviewer', reviewedAt: '2026-08-16T00:00:00.000Z', evidenceReviewed: 'run metrics, baseline, candidate, segments, and limitations', rollbackTarget: 'baseline-v1', notes: 'Real reviewer decision and rationale recorded for this run.' }))
  }
}

describe('human evidence worksheet validator', () => {
  it('prepares exactly four roles and six shadow reviews without submission authority', () => {
    expect(validateHumanEvidenceWorksheet({ content: worksheet() })).toMatchObject({
      status: 'prepared_for_human_submission',
      prepared: true,
      signoffs: { supplied: 4, missingRoles: [] },
      shadowReviews: { supplied: 6, missingRunIds: [] },
      submissionPerformed: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    })
  })

  it('blocks missing roles and shadow runs', () => {
    const result = validateHumanEvidenceWorksheet({ content: { signoffs: worksheet().signoffs.slice(0, 3), shadowReviews: worksheet().shadowReviews.slice(0, 5) } })
    expect(result.prepared).toBe(false)
    expect(result.signoffs.missingRoles).toEqual(['security'])
    expect(result.shadowReviews.missingRunIds).toEqual([runIds[5]])
  })

  it('rejects placeholders and sensitive fields', () => {
    expect(() => validateHumanEvidenceWorksheet({ content: { signoffs: [{ role: 'security', approved: true, reviewerId: '<REAL_ID>', notes: 'TODO' }], shadowReviews: [], privateKey: 'never' } })).toThrow(/sensitive field|placeholder text/)
  })

  it('blocks duplicate roles, duplicate runs, and unsupported decisions', () => {
    const value = worksheet()
    value.signoffs[1].role = value.signoffs[0].role
    value.shadowReviews[1].runId = value.shadowReviews[0].runId
    value.shadowReviews[0].decision = 'approved'
    const result = validateHumanEvidenceWorksheet({ content: value })
    expect(result.prepared).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('duplicate sign-off role'), expect.stringContaining('duplicate shadow run'), expect.stringContaining('decision must be approved_pilot or rejected')]))
  })
})
