import { describe, expect, it } from 'vitest'
import { buildReleaseEvidenceBundle, buildUnifiedOperatorEvidence } from '../lib/releaseEvidenceService.js'

const baseEvidence = {
  targetOperations: { status: 'ready', releaseEligible: false },
  deploymentPreflight: { ready: true },
  readiness: { checks: { database: { ready: true } } },
  verifierOperations: { status: 'ready', reconciliation: { status: 'ok' } },
  reconciliation: { status: 'ok' },
  outboxHealth: { status: 'ok' },
  webhookInboxHealth: { status: 'ok' },
  pendingShadowReviews: 0,
  rollbackTargets: 1,
  reviewerAttestationSummary: {
    complete: true,
    required: 4,
    requiredRoles: ['release_operator', 'protocol_finance', 'ai_data', 'security'],
    releaseCommit: '090e837644d3cb6f4516ed10414e7603fed3d150',
    supplied: 4,
    valid: 4,
    rolesPresent: ['release_operator', 'protocol_finance', 'ai_data', 'security'],
    missingRoles: [],
    duplicateRoles: [],
    rejectedRoles: [],
    identitiesIncluded: false,
    signatureBytesIncluded: false
  },
  signoffs: [
    { role: 'release_operator', approved: true, reviewerId: 'release-operator', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { role: 'protocol_finance', approved: true, reviewerId: 'protocol-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { role: 'ai_data', approved: true, reviewerId: 'ai-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { role: 'security', approved: true, reviewerId: 'security-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true }
  ],
  signingKeyEvidence: { present: true, publicKeyFingerprintSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', independentlyVerified: true }
}

describe('release evidence aggregation', () => {
  it('reports complete evidence but never marks the release eligible', () => {
    const bundle = buildReleaseEvidenceBundle(baseEvidence)
    expect(bundle.status).toBe('evidence_complete_pending_release_gate')
    expect(bundle.evidenceComplete).toBe(true)
    expect(bundle.releaseEligible).toBe(false)
    expect(bundle.signingKeyMaterialIncluded).toBe(false)
    expect(bundle.signoffSummary.missingRoles).toEqual([])
    expect(bundle.reviewerAttestationSummary.missingRoles).toEqual([])
    expect(bundle.signingKeyEvidence.publicKeyFingerprintSha256).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(bundle.authority).toBe('release_evidence_aggregation_only')
    expect(bundle.settlementAuthority).toBe(false)
    expect(bundle.evidenceFingerprint.algorithm).toBe('sha256')
    expect(bundle.evidenceFingerprint.kind).toBe('release_evidence')
  })

  it('combines release and reconciliation evidence without granting release authority', () => {
    const releaseEvidence = buildReleaseEvidenceBundle(baseEvidence)
    const unified = buildUnifiedOperatorEvidence({
      releaseEvidence,
      reconciliationEvidence: { status: 'verified', evidenceHash: 'reconciliation-hash' }
    })
    expect(unified.status).toBe('complete_pending_release_gate')
    expect(unified.evidenceComplete).toBe(true)
    expect(unified.evidenceFingerprint.kind).toBe('operator_evidence')
    expect(unified.releaseEligible).toBe(false)
    expect(unified.settlementAuthority).toBe(false)
    expect(unified.mutation).toBe('read_only')
  })

  it('requires all distinct reviewer roles and independently verified public-key fingerprint evidence', () => {
    const bundle = buildReleaseEvidenceBundle({ ...baseEvidence, signoffs: baseEvidence.signoffs.slice(0, 3), signingKeyEvidence: { present: true, publicKeyFingerprintSha256: 'bad', independentlyVerified: false } })
    expect(bundle.evidenceComplete).toBe(false)
    expect(bundle.signoffSummary.missingRoles).toEqual(['security'])
    expect(bundle.checks.find((item) => item.name === 'signingKey').ready).toBe(false)
    expect(bundle.signingKeyMaterialIncluded).toBe(false)
  })

  it('names missing target and human evidence without weakening the gate', () => {
    const bundle = buildReleaseEvidenceBundle({
      targetOperations: { status: 'blocked', releaseEligible: false },
      pendingShadowReviews: 6,
      signoffs: []
    })
    expect(bundle.status).toBe('blocked')
    expect(bundle.evidenceComplete).toBe(false)
    expect(bundle.releaseEligible).toBe(false)
    expect(bundle.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['targetOperations', 'deploymentPreflight', 'verifierOperations', 'shadowReviews', 'humanSignoffs', 'reviewerAttestations', 'signingKey']))
  })
})
