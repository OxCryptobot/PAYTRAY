import { describe, expect, it } from 'vitest'
import { buildVerifierReconciliationEvidence } from '../scripts/verify-verifier-reconciliation-evidence.mjs'

function verifierReport(status = 'ready') {
  return {
    value: status === 'ready'
      ? { status: 'ready', verifier: { verifierStatus: { status: 'fresh', ready: true } } }
      : { status: 'blocked', reason: 'verifier status is missing', verifier: { verifierStatus: { status: 'missing', ready: false } } },
    source: '/tmp/verifier.json',
    sha256: 'v'.repeat(64)
  }
}

function reconciliationReport({ status = 'verified', issueCount = 0 } = {}) {
  return {
    value: { evidence: { status, issueCount, report: { summary: { issues: issueCount } } } },
    source: '/tmp/reconciliation.json',
    sha256: 'r'.repeat(64)
  }
}

describe('verifier/reconciliation evidence composer', () => {
  it('verifies only when the cursor is fresh and reconciliation is clean', () => {
    const result = buildVerifierReconciliationEvidence({
      verifier: verifierReport(),
      reconciliation: reconciliationReport(),
      evidenceTarget: 'local_disposable'
    })

    expect(result).toMatchObject({
      status: 'verified',
      evidenceTarget: 'local_disposable',
      authenticatedTarget: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      checks: [
        { label: 'verifier', status: 'fresh', ready: true },
        { label: 'reconciliation', status: 'verified', ready: true, issueCount: 0 }
      ]
    })
    expect(result.blockers).toEqual([])
  })

  it('blocks a missing durable verifier cursor even when reconciliation is clean', () => {
    const result = buildVerifierReconciliationEvidence({
      verifier: verifierReport('missing'),
      reconciliation: reconciliationReport(),
      evidenceTarget: 'local_disposable'
    })

    expect(result.status).toBe('operator_blocked')
    expect(result.blockers).toContainEqual({ label: 'verifier', reason: 'verifier status is missing' })
  })

  it('blocks reconciliation issues and non-verified evidence', () => {
    const result = buildVerifierReconciliationEvidence({
      verifier: verifierReport(),
      reconciliation: reconciliationReport({ status: 'attention', issueCount: 1 }),
      evidenceTarget: 'authenticated_target'
    })

    expect(result.status).toBe('operator_blocked')
    expect(result.authenticatedTarget).toBe(true)
    expect(result.blockers).toEqual([
      { label: 'reconciliation', reason: 'reconciliation status is attention' },
      { label: 'reconciliation-issues', reason: 'reconciliation issue count is 1' }
    ])
  })

  it('rejects sensitive evidence keys rather than redacting them implicitly', () => {
    expect(() => buildVerifierReconciliationEvidence({
      verifier: { value: { privateKey: 'must-not-appear' }, source: '/tmp/verifier.json', sha256: 'v'.repeat(64) },
      reconciliation: reconciliationReport()
    })).toThrow('sensitive key is not allowed')
  })
})
