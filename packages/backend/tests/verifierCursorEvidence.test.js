import { describe, expect, it } from 'vitest'
import { buildVerifierCursorEvidence } from '../scripts/verify-verifier-cursor-evidence.mjs'

function operationsReport({ status = 'ready', cursor = { last_scanned_block: '123', updated_at: '2026-08-17T19:00:00.000Z' }, verifierStatus = 'fresh', unlinkedEvidenceCount = 0 } = {}) {
  return {
    value: {
      status,
      verifier: {
        chainId: 84532,
        configured: true,
        cursor,
        verifierStatus: { status: verifierStatus, ready: verifierStatus === 'fresh', reason: `durable verifier cursor is ${verifierStatus}` },
        unlinkedEvidenceCount
      }
    },
    source: '/tmp/verifier-operations.json',
    sha256: 'a'.repeat(64)
  }
}

describe('verifier cursor evidence', () => {
  it('verifies a fresh Base Sepolia cursor with clean linked evidence', () => {
    const result = buildVerifierCursorEvidence({
      operations: operationsReport(),
      evidenceTarget: 'local_disposable'
    })

    expect(result).toMatchObject({
      status: 'verified',
      evidenceTarget: 'local_disposable',
      authenticatedTarget: false,
      chainId: 84532,
      cursor: { lastScannedBlock: 123, updatedAt: '2026-08-17T19:00:00.000Z' },
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      blockers: []
    })
    expect(result.checks.every((check) => check.ready)).toBe(true)
  })

  it('blocks a missing cursor even when the chain policy is configured', () => {
    const result = buildVerifierCursorEvidence({
      operations: operationsReport({ status: 'blocked', cursor: null, verifierStatus: 'missing' }),
      evidenceTarget: 'authenticated_target'
    })

    expect(result.status).toBe('operator_blocked')
    expect(result.authenticatedTarget).toBe(true)
    expect(result.blockers).toEqual(expect.arrayContaining([
      { label: 'report-status', reason: 'verifier operations report is not ready' },
      { label: 'cursor-status', reason: 'durable verifier cursor is missing' },
      { label: 'cursor-metadata', reason: 'cursor must include a nonnegative integer last_scanned_block and parseable updated_at' }
    ]))
  })

  it('blocks stale cursors and unlinked chain evidence', () => {
    const result = buildVerifierCursorEvidence({
      operations: operationsReport({ verifierStatus: 'stale', unlinkedEvidenceCount: 2 })
    })

    expect(result.status).toBe('operator_blocked')
    expect(result.blockers).toEqual(expect.arrayContaining([
      { label: 'cursor-status', reason: 'durable verifier cursor is stale' },
      { label: 'unlinked-evidence', reason: 'unlinked chain evidence remains' }
    ]))
  })

  it('blocks invalid cursor metadata', () => {
    const result = buildVerifierCursorEvidence({
      operations: operationsReport({ cursor: { last_scanned_block: '-1', updated_at: 'not-a-date' } })
    })

    expect(result.status).toBe('operator_blocked')
    expect(result.blockers).toContainEqual({ label: 'cursor-metadata', reason: 'cursor must include a nonnegative integer last_scanned_block and parseable updated_at' })
  })

  it('rejects sensitive fields instead of silently carrying them into evidence', () => {
    expect(() => buildVerifierCursorEvidence({
      operations: { ...operationsReport(), value: { privateKey: 'must-not-appear' } }
    })).toThrow('sensitive key is not allowed')
  })
})
