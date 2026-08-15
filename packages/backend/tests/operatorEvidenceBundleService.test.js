import { describe, expect, it } from 'vitest'
import { buildOperatorEvidenceBundle } from '../lib/operatorEvidenceBundleService.js'

const releaseEvidence = {
  evidenceComplete: true,
  evidenceFingerprint: { value: 'release-fingerprint' },
  blockers: [],
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only'
}
const reconciliationEvidence = {
  status: 'verified',
  evidenceHash: 'reconciliation-hash',
  settlementAuthority: false,
  mutation: 'read_only'
}
const operationsQualityRuns = {
  runs: [
    {
      run_id: '11111111-1111-4111-8111-111111111111',
      status: 'operator_blocked',
      strict_mode: false,
      check_count: 8,
      passed_count: 5,
      operator_blocker_count: 3,
      unexpected_failure_count: 0,
      report_hash: 'a'.repeat(64),
      completed_at: '2026-08-15T20:00:00.000Z'
    }
  ]
}

describe('operator evidence bundle service', () => {
  it('builds a complete-pending-release bundle with deterministic references', () => {
    const first = buildOperatorEvidenceBundle({
      releaseEvidence,
      reconciliationEvidence,
      operationsQualityRuns,
      gitCommit: 'commit-1',
      now: new Date('2026-08-15T20:00:00.000Z')
    })
    const second = buildOperatorEvidenceBundle({
      releaseEvidence,
      reconciliationEvidence,
      operationsQualityRuns,
      gitCommit: 'commit-1',
      now: new Date('2026-08-15T20:00:00.000Z')
    })

    expect(first).toMatchObject({
      status: 'complete_pending_release_gate',
      bundleVersion: 'v1',
      evidenceComplete: true,
      gitCommit: 'commit-1',
      authority: 'operator_evidence_bundle_export_only',
      paymentStateAuthority: 'verifier_and_ledger_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      quality: { count: 1, latest: { runId: '11111111-1111-4111-8111-111111111111', unexpectedFailureCount: 0 } }
    })
    expect(first.evidenceFingerprint).toEqual(second.evidenceFingerprint)
    expect(first.references.operationsQualityRunIds).toEqual(['11111111-1111-4111-8111-111111111111'])
  })

  it('fails closed and names reconciliation blockers without inventing evidence', () => {
    const result = buildOperatorEvidenceBundle({ releaseEvidence, reconciliationEvidence: { status: 'attention', evidenceHash: null }, operationsQualityRuns: { runs: [] } })

    expect(result).toMatchObject({ status: 'blocked', evidenceComplete: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toContainEqual({ name: 'reconciliation', reason: 'reconciliation evidence is not verified' })
    expect(result.references.reconciliationEvidenceHash).toBe(null)
    expect(result.quality).toEqual({ count: 0, latest: null })
  })
})
