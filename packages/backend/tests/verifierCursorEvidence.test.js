import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVerifierCursorEvidence } from '../scripts/verify-verifier-cursor-evidence.mjs'

const script = path.resolve(process.cwd(), 'scripts/verify-verifier-cursor-evidence.mjs')

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

  it('rejects symlinked and non-regular CLI operations reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-cursor-inputs-'))
    try {
      const reportPath = path.join(root, 'operations.json')
      const symlinkPath = path.join(root, 'operations-link.json')
      const directoryPath = path.join(root, 'operations-directory')
      fs.writeFileSync(reportPath, JSON.stringify(operationsReport().value), { mode: 0o600 })
      fs.symlinkSync(reportPath, symlinkPath)
      fs.mkdirSync(directoryPath)

      const invoke = (filePath) => {
        const result = spawnSync(process.execPath, [script], {
          cwd: process.cwd(),
          env: { ...process.env, VERIFIER_OPERATIONS_FILE: filePath },
          encoding: 'utf8'
        })
        return { status: result.status, output: JSON.parse(result.stdout) }
      }

      const symlinkResult = invoke(symlinkPath)
      expect(symlinkResult.status).toBe(1)
      expect(symlinkResult.output).toMatchObject({ status: 'operator_blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, authority: 'verifier_cursor_evidence_only' })
      expect(symlinkResult.output.reason).toContain('must not be a symlink')

      const directoryResult = invoke(directoryPath)
      expect(directoryResult.status).toBe(1)
      expect(directoryResult.output).toMatchObject({ status: 'operator_blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(directoryResult.output.reason).toContain('must be a regular file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
