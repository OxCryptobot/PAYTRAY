import { describe, expect, it } from 'vitest'
import { buildReleaseApprovalArtifact } from '../lib/releaseApprovalGate.js'
import { buildPostAttestationSequenceReport } from '../scripts/verify-post-attestation-release-sequence.mjs'
import { validateReviewerAttestationBundle } from '../scripts/verify-reviewer-attestation-bundle.mjs'
import { buildDurableWorkerEvidence } from '../scripts/verify-durable-worker-evidence.mjs'

const base = {
  deploymentPreflight: { ready: true, settlement: { chainId: 84532, mainnetEnabled: false }, checks: [] },
  readiness: { checks: { database: { ready: true } } },
  reconciliation: { status: 'ok', summary: { issues: 0 } },
  verifierStatus: { status: 'fresh', ready: true },
  pendingShadowReviews: 0,
  rollbackTargets: 1
}

const sequenceChecks = [
  'railway-trial',
  'target-operations',
  'recovery',
  'verifier-operations',
  'reconciliation-evidence',
  'outbox-health',
  'idempotency-cleanup',
  'release-evidence',
  'release-approval',
  'operator-key-custody',
  'secret-manager-custody',
  'release-manifest',
  'release-payload'
]

function makeSequenceReport(state = 'passed') {
  return {
    reportKind: 'release_gates',
    releaseEligible: false,
    settlementAuthority: false,
    checks: sequenceChecks.map((name) => ({ name, state, reason: state === 'passed' ? 'check passed' : 'operator evidence is required', mutation: 'read_only', releaseEligible: false, settlementAuthority: false }))
  }
}

describe('release approval gate', () => {
  it('fails closed until explicit human approval is supplied', () => {
    const artifact = buildReleaseApprovalArtifact(base)
    expect(artifact).toMatchObject({ status: 'blocked', eligible: false, approvalRequired: true, promotionStatus: 'shadow_only', authority: 'human_approval_required', mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
    expect(artifact.checks.find((check) => check.name === 'humanApproval')).toMatchObject({ ready: false })
  })

  it('approves only when all operational evidence and explicit human approval are present', () => {
    const artifact = buildReleaseApprovalArtifact({ ...base, humanApproval: { approved: true, reviewerId: 'operator-1', approvedAt: '2026-08-14T22:00:00.000Z', scope: 'production_release', rollbackAcknowledged: true } })
    expect(artifact.status).toBe('approved')
    expect(artifact.eligible).toBe(true)
    expect(artifact.checks.every((check) => check.ready)).toBe(true)
  })

  it('blocks incomplete human approval evidence', () => {
    const artifact = buildReleaseApprovalArtifact({ ...base, humanApproval: { approved: true, reviewerId: 'operator-1' } })
    expect(artifact.status).toBe('blocked')
    expect(artifact.checks.find((check) => check.name === 'humanApproval')).toMatchObject({ ready: false })
  })

  it('blocks stale verifier or unresolved reconciliation evidence', () => {
    const artifact = buildReleaseApprovalArtifact({ ...base, verifierStatus: { status: 'stale', ready: false }, reconciliation: { status: 'attention', summary: { issues: 1 } }, humanApproval: { approved: true } })
    expect(artifact.status).toBe('blocked')
    expect(artifact.checks.find((check) => check.name === 'verifier').ready).toBe(false)
    expect(artifact.checks.find((check) => check.name === 'reconciliation').ready).toBe(false)
  })

  it('maps post-attestation blockers into ordered release stages without granting authority', () => {
    const result = buildPostAttestationSequenceReport({ report: makeSequenceReport('operator_blocked'), sourceSha256: 'a'.repeat(64) })
    expect(result).toMatchObject({ status: 'operator_blocked', sequence: 'post_shadow_review_attestation', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.orderedStages.map((stage) => stage.id)).toEqual(['target-evidence', 'target-recovery', 'fresh-verifier', 'reconciliation', 'durable-workers', 'human-evidence', 'operator-custody', 'manifest-payload'])
    expect(result.blockingChecks.length).toBe(13)
  })

  it('reports a complete ordered sequence as verified while preserving false authority fields', () => {
    const result = buildPostAttestationSequenceReport({ report: makeSequenceReport('passed') })
    expect(result.status).toBe('verified')
    expect(result.orderedStages.every((stage) => stage.status === 'verified')).toBe(true)
    expect(result.releaseEligible).toBe(false)
    expect(result.settlementAuthority).toBe(false)
    expect(result.mutation).toBe('read_only')
  })

  it('rejects authority violations and sensitive fields in release-gate reports', () => {
    expect(() => buildPostAttestationSequenceReport({ report: { ...makeSequenceReport(), releaseEligible: true } })).toThrow('immutable authority violation')
    expect(() => buildPostAttestationSequenceReport({ report: { ...makeSequenceReport(), signature: '0x' } })).toThrow('sensitive key')
  })

  it('fails closed when the four-role attestation bundle is incomplete', () => {
    expect(() => validateReviewerAttestationBundle({ content: { status: 'ok', attestations: [] } })).toThrow('exactly four attestations')
  })

  it('accepts safe false-valued redaction metadata while rejecting raw EIP-191 signatures', () => {
    expect(() => validateReviewerAttestationBundle({ content: { status: 'ok', signatureBytesIncluded: false, attestations: [] } })).toThrow('exactly four attestations')
    expect(() => validateReviewerAttestationBundle({ content: { status: 'ok', signature: '0x', attestations: [] } })).toThrow('sensitive key')
  })

  it('rejects an attestation bundle that attempts to grant release authority', () => {
    expect(() => validateReviewerAttestationBundle({ content: { status: 'ok', releaseEligible: true, attestations: [] } })).toThrow('immutable authority violation')
  })

  it('verifies local durable-worker evidence without granting target release authority', () => {
    const result = buildDurableWorkerEvidence({
      evidenceTarget: 'local_disposable',
      outboxHealth: { value: { status: 'ok', mutation: 'read_only' }, source: 'outbox-health.json', sha256: 'a'.repeat(64) },
      outboxWorker: { value: { status: 'ready', mutation: 'outbox_delivery_only' }, source: 'outbox-worker.json', sha256: 'b'.repeat(64) },
      idempotencyCleanup: { value: { status: 'ready', mutation: 'expired_idempotency_cleanup_only' }, source: 'idempotency.json', sha256: 'c'.repeat(64) }
    })
    expect(result).toMatchObject({ status: 'verified', evidenceTarget: 'local_disposable', authenticatedTarget: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toHaveLength(0)
  })

  it('preserves blocked durable-worker evidence as an operator blocker', () => {
    const result = buildDurableWorkerEvidence({
      evidenceTarget: 'authenticated_target',
      outboxHealth: { value: { status: 'ok' }, source: 'outbox-health.json', sha256: 'a'.repeat(64) },
      outboxWorker: { value: { status: 'blocked', reason: 'WEBHOOK_SIGNING_SECRET is required' }, source: 'outbox-worker.json', sha256: 'b'.repeat(64) },
      idempotencyCleanup: { value: { status: 'blocked', reason: 'IDEMPOTENCY_CLEANUP_ENABLED=true is required' }, source: 'idempotency.json', sha256: 'c'.repeat(64) }
    })
    expect(result).toMatchObject({ status: 'operator_blocked', evidenceTarget: 'authenticated_target', authenticatedTarget: true, releaseEligible: false, settlementAuthority: false })
    expect(result.blockers.map((blocker) => blocker.label)).toEqual(['outbox-worker', 'idempotency-cleanup'])
  })
})
