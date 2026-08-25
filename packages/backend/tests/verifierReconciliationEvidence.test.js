import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVerifierReconciliationEvidence } from '../scripts/verify-verifier-reconciliation-evidence.mjs'

const script = path.resolve(process.cwd(), 'scripts/verify-verifier-reconciliation-evidence.mjs')

function runCli(verifierPath, reconciliationPath) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFIER_OPERATIONS_FILE: verifierPath,
      RECONCILIATION_EVIDENCE_FILE: reconciliationPath,
      VERIFIER_RECONCILIATION_EVIDENCE_TARGET: 'local_disposable'
    }
  })
}

function writeJson(root, filename, value) {
  const filePath = path.join(root, filename)
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 })
  return filePath
}

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

  it('rejects symlinked and non-regular direct inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-reconciliation-inputs-'))
    try {
      const verifierPath = writeJson(root, 'verifier.json', verifierReport().value)
      const reconciliationPath = writeJson(root, 'reconciliation.json', reconciliationReport().value)
      const verifierSymlinkPath = path.join(root, 'verifier-link.json')
      const reconciliationDirectoryPath = path.join(root, 'reconciliation-directory')
      fs.symlinkSync(verifierPath, verifierSymlinkPath)
      fs.mkdirSync(reconciliationDirectoryPath)

      const symlinkResult = runCli(verifierSymlinkPath, reconciliationPath)
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        reportKind: 'verifier_reconciliation_evidence',
        status: 'operator_blocked',
        reason: 'VERIFIER_OPERATIONS_FILE file must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'verifier_reconciliation_evidence_only'
      })

      const directoryResult = runCli(verifierPath, reconciliationDirectoryPath)
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        reportKind: 'verifier_reconciliation_evidence',
        status: 'operator_blocked',
        reason: 'RECONCILIATION_EVIDENCE_FILE file must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        authority: 'verifier_reconciliation_evidence_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects sensitive evidence keys rather than redacting them implicitly', () => {
    expect(() => buildVerifierReconciliationEvidence({
      verifier: { value: { privateKey: 'must-not-appear' }, source: '/tmp/verifier.json', sha256: 'v'.repeat(64) },
      reconciliation: reconciliationReport()
    })).toThrow('sensitive key is not allowed')
  })
})
