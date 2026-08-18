import { describe, expect, it } from 'vitest'
import { buildHumanEvidenceCustodyReport } from '../scripts/verify-human-evidence-custody.mjs'

const roles = ['release_operator', 'protocol_finance', 'ai_data', 'security']

function releaseEvidence(overrides = {}) {
  return {
    bundle: {
      signoffSummary: { requiredRoles: roles, supplied: 4, valid: 4, rolesPresent: roles, complete: true },
      reviewerAttestationSummary: { requiredRoles: roles, supplied: 4, valid: 4, rolesPresent: roles, complete: true },
      signingKeyEvidence: { present: true, independentlyVerified: true, ready: true },
      ...overrides
    }
  }
}

function operatorKey(overrides = {}) {
  return { status: 'verified', custodyVerified: true, independentVerification: true, ...overrides }
}

function secretManager(overrides = {}) {
  return { status: 'verified', ephemeralInjectionVerified: true, persistedSecret: false, ...overrides }
}

describe('human evidence and custody report', () => {
  it('reports complete evidence without granting release authority', () => {
    const result = buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager(), target: 'authenticated_target' })
    expect(result).toMatchObject({ status: 'verified', target: 'authenticated_target', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toEqual([])
  })

  it('lists every missing role and custody blocker', () => {
    const result = buildHumanEvidenceCustodyReport({
      releaseEvidence: releaseEvidence({ signoffSummary: { requiredRoles: roles, supplied: 0, valid: 0, rolesPresent: [], complete: false }, reviewerAttestationSummary: { requiredRoles: roles, supplied: 0, valid: 0, rolesPresent: [], complete: false } }),
      operatorKey: operatorKey({ status: 'blocked', custodyVerified: false, independentVerification: false }),
      secretManager: secretManager({ status: 'blocked', ephemeralInjectionVerified: false, persistedSecret: false })
    })
    expect(result.status).toBe('blocked')
    expect(result.humanSignoffs.missingRoles).toEqual(roles)
    expect(result.reviewerAttestations.missingRoles).toEqual(roles)
    expect(result.blockers.map((blocker) => blocker.name)).toEqual(['humanSignoffs', 'reviewerAttestations', 'ed25519Custody'])
  })

  it('rejects sensitive key material in source evidence', () => {
    expect(() => buildHumanEvidenceCustodyReport({ releaseEvidence: { privateKeyPem: 'forbidden' }, operatorKey: operatorKey(), secretManager: secretManager() })).toThrow('sensitive key is not allowed')
  })

  it('rejects unsupported targets and never infers authenticated status', () => {
    expect(() => buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager(), target: 'inferred_target' })).toThrow('unsupported human evidence target')
    const result = buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager() })
    expect(result.target).toBe('local_disposable')
  })
})
