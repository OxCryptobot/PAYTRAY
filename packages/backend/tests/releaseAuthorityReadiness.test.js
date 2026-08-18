import { describe, expect, it } from 'vitest'
import { buildReleaseAuthorityReadiness } from '../scripts/verify-release-authority-readiness.mjs'

const releaseCommit = 'a'.repeat(40)

function evidence(overrides = {}) {
  return {
    releaseApproval: {
      status: 'approved',
      eligible: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseApproval
    },
    releaseEvidence: {
      evidenceComplete: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseEvidence
    },
    shadowReviewStatus: {
      status: 'complete',
      expectedRunCount: 6,
      observedRunCount: 6,
      pendingCount: 0,
      terminalCount: 6,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.shadowReviewStatus
    },
    cryptographicSequence: {
      status: 'verified',
      cryptographicSequenceComplete: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.cryptographicSequence
    },
    signedPayload: {
      status: 'verified',
      signatureValid: true,
      evidenceReady: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.signedPayload
    },
    releaseCommit,
    target: 'local_disposable'
  }
}

describe('release authority readiness', () => {
  it('requires all genuine evidence but never grants release authority', () => {
    const result = buildReleaseAuthorityReadiness(evidence())
    expect(result).toMatchObject({ status: 'ready_for_controlled_release_evaluation', readyForControlledEvaluation: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toEqual([])
  })

  it('blocks missing sign-offs and pending shadow reviews', () => {
    const result = buildReleaseAuthorityReadiness(evidence({
      releaseApproval: { status: 'blocked', eligible: false },
      releaseEvidence: { evidenceComplete: false },
      shadowReviewStatus: { status: 'pending_human_review', pendingCount: 2, terminalCount: 4 }
    }))
    expect(result.status).toBe('blocked')
    expect(result.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['releaseApproval', 'releaseEvidence', 'shadowReviews']))
  })

  it('blocks mismatched commit binding', () => {
    const result = buildReleaseAuthorityReadiness(evidence({ signedPayload: { releaseCommit: 'b'.repeat(40) } }))
    expect(result.status).toBe('blocked')
    expect(result.blockers).toContainEqual({ name: 'releaseCommit', reason: 'all supplied evidence is bound to the exact release commit' })
  })

  it('rejects sensitive material and authority violations', () => {
    expect(() => buildReleaseAuthorityReadiness(evidence({ signedPayload: { signature: 'raw' } }))).toThrow('sensitive keys')
    expect(() => buildReleaseAuthorityReadiness(evidence({ releaseEvidence: { releaseEligible: true } }))).toThrow('authority or mutation violation')
  })
})
