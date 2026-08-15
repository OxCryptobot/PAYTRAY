import { describe, expect, it } from 'vitest'
import { buildReleaseEvidenceBundle } from '../lib/releaseEvidenceService.js'

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
  signoffs: [
    { approved: true, reviewerId: 'release-operator', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { approved: true, reviewerId: 'protocol-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { approved: true, reviewerId: 'ai-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true },
    { approved: true, reviewerId: 'security-reviewer', approvedAt: '2026-08-15T00:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true }
  ],
  signingKeyEvidencePresent: true
}

describe('release evidence aggregation', () => {
  it('reports complete evidence but never marks the release eligible', () => {
    const bundle = buildReleaseEvidenceBundle(baseEvidence)
    expect(bundle.status).toBe('evidence_complete_pending_release_gate')
    expect(bundle.evidenceComplete).toBe(true)
    expect(bundle.releaseEligible).toBe(false)
    expect(bundle.signingKeyMaterialIncluded).toBe(false)
    expect(bundle.authority).toBe('release_evidence_aggregation_only')
    expect(bundle.settlementAuthority).toBe(false)
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
    expect(bundle.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['targetOperations', 'deploymentPreflight', 'verifierOperations', 'shadowReviews', 'humanSignoffs', 'signingKey']))
  })
})
