import { describe, expect, it } from 'vitest'
import { buildReconciliationEvidence } from '../lib/reconciliationEvidenceService.js'

describe('reconciliation evidence', () => {
  it('hashes canonical report content deterministically', () => {
    const first = buildReconciliationEvidence({
      report: { status: 'ok', issues: [], summary: { streams: 0, intents: 0 } },
      gitCommit: 'abc123'
    })
    const second = buildReconciliationEvidence({
      report: { summary: { intents: 0, streams: 0 }, issues: [], status: 'ok' },
      gitCommit: 'abc123'
    })

    expect(first.status).toBe('verified')
    expect(first.evidenceHash).toBe(second.evidenceHash)
    expect(first.gitCommit).toBe('abc123')
    expect(first.settlementAuthority).toBe(false)
    expect(first.mutation).toBe('read_only')
    expect(first.deploymentPerformed).toBe(false)
  })

  it('retains attention status and issue count without changing authority', () => {
    const evidence = buildReconciliationEvidence({
      report: { status: 'attention', issues: [{ type: 'projection_lag' }] }
    })
    expect(evidence.status).toBe('attention')
    expect(evidence.issueCount).toBe(1)
    expect(evidence.settlementAuthority).toBe(false)
    expect(evidence.settlementMutationPerformed).toBe(false)
  })
})
