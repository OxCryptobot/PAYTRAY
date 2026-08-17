import { describe, expect, it } from 'vitest'
import { validateOperationsQualityArtifact } from '../scripts/verify-operations-quality-artifact.mjs'

function makeArtifact(overrides = {}) {
  return {
    reportKind: 'operations_quality',
    status: 'operator_blocked',
    strict: false,
    checkCount: 1,
    passedCount: 0,
    operatorBlockerCount: 1,
    unexpectedFailureCount: 0,
    checks: [{ name: 'fixture', state: 'operator_blocked', status: 'blocked', expectedBlocked: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }],
    operatorBlockers: [{ name: 'fixture', status: 'blocked', reason: 'disposable fixture' }],
    unexpectedFailures: [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    audit: {
      status: 'not_recorded',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    },
    ...overrides
  }
}

describe('operations-quality artifact verifier', () => {
  it('verifies a redacted no-database report while preserving safety fields', () => {
    const result = validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact()) })
    expect(result).toMatchObject({ status: 'verified', reportKind: 'operations_quality', audit: { status: 'not_recorded' }, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
  })

  it('requires durable migration-018 audit persistence for recovery artifacts', () => {
    expect(() => validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact()), requireAudit: true })).toThrow('durable migration-018 audit persistence')
  })

  it('accepts a recorded audit only with exact run and report hash', () => {
    const result = validateOperationsQualityArtifact({
      content: JSON.stringify(makeArtifact({
        audit: {
          status: 'recorded',
          runId: '11111111-1111-4111-8111-111111111111',
          reportHash: 'a'.repeat(64),
          releaseEligible: false,
          settlementAuthority: false,
          mutation: 'read_only',
          deploymentPerformed: false,
          settlementMutationPerformed: false
        }
      })),
      requireAudit: true
    })
    expect(result.audit).toMatchObject({ status: 'recorded', runId: '11111111-1111-4111-8111-111111111111', reportHash: 'a'.repeat(64) })
  })

  it('rejects sensitive fields in captured JSON', () => {
    expect(() => validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact({ audit: { ...makeArtifact().audit, signature: 'forbidden' } })) })).toThrow('sensitive key')
  })
})
