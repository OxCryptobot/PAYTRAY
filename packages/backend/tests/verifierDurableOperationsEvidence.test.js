import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVerifierDurableOperationsEvidence } from '../scripts/verify-verifier-durable-operations-evidence.mjs'

const releaseCommit = 'a'.repeat(40)
const script = path.resolve(process.cwd(), 'scripts/verify-verifier-durable-operations-evidence.mjs')

function runCli(recoveryFile, verifierReconciliationFile, durableWorkerFile) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFIER_DURABLE_RECOVERY_FILE: recoveryFile,
      VERIFIER_RECONCILIATION_FILE: verifierReconciliationFile,
      DURABLE_WORKER_EVIDENCE_FILE: durableWorkerFile,
      VERIFIER_DURABLE_EVIDENCE_TARGET: 'local_disposable',
      VERIFIER_DURABLE_EVIDENCE_COMMIT: releaseCommit
    }
  })
}

function writeJson(root, name, value) {
  const filePath = path.join(root, name)
  const raw = JSON.stringify(value)
  fs.writeFileSync(filePath, raw, { mode: 0o600 })
  return { filePath, sha256: createHash('sha256').update(raw).digest('hex') }
}

function recovery(overrides = {}) {
  return {
    reportKind: 'recovery_evidence',
    status: 'verified',
    restore: { status: 'verified', migrationCount: 20, database: 'postgresql://isolated/paytray' },
    mutation: 'isolated_recovery_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    releaseCommit,
    ...overrides
  }
}

function verifierReconciliation(overrides = {}) {
  return {
    reportKind: 'verifier_reconciliation_evidence',
    status: 'verified',
    checks: [
      { label: 'verifier', status: 'fresh', ready: true },
      { label: 'reconciliation', status: 'verified', ready: true, issueCount: 0 }
    ],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    releaseCommit,
    ...overrides
  }
}

function durableWorker(overrides = {}) {
  return {
    reportKind: 'durable_worker_evidence',
    status: 'verified',
    checks: [
      { label: 'outbox-health', status: 'ok', ready: true },
      { label: 'outbox-worker', status: 'ready', ready: true },
      { label: 'idempotency-cleanup', status: 'ready', ready: true }
    ],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    releaseCommit,
    ...overrides
  }
}

describe('verifier durable operations evidence', () => {
  it('verifies recovery, fresh verifier/reconciliation, and durable workers without authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-durable-'))
    try {
      const recoveryFile = writeJson(root, 'recovery.json', recovery())
      const verifierFile = writeJson(root, 'verifier-reconciliation.json', verifierReconciliation())
      const durableFile = writeJson(root, 'durable-worker.json', durableWorker())
      const report = buildVerifierDurableOperationsEvidence({ recoveryFile: recoveryFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'local_disposable', releaseCommit })
      expect(report).toMatchObject({ reportKind: 'verifier_durable_operations_evidence', status: 'verified_reference', evidenceCount: 3, verifiedReferenceCount: 3, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(report.checks.every((check) => check.status === 'verified_reference')).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps incomplete recovery, verifier, reconciliation, or worker evidence blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-durable-blocked-'))
    try {
      const recoveryFile = writeJson(root, 'recovery.json', recovery({ restore: { status: 'verified', migrationCount: 18 } }))
      const verifierFile = writeJson(root, 'verifier-reconciliation.json', verifierReconciliation({ checks: [{ label: 'verifier', status: 'stale', ready: false }, { label: 'reconciliation', status: 'verified', ready: false, issueCount: 2 }] }))
      const durableFile = writeJson(root, 'durable-worker.json', durableWorker({ status: 'operator_blocked' }))
      const report = buildVerifierDurableOperationsEvidence({ recoveryFile: recoveryFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'local_disposable', releaseCommit })
      expect(report.status).toBe('blocked')
      expect(report.verifiedReferenceCount).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and non-regular direct inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-durable-inputs-'))
    try {
      const recoveryFile = writeJson(root, 'recovery.json', recovery()).filePath
      const verifierFile = writeJson(root, 'verifier-reconciliation.json', verifierReconciliation()).filePath
      const durableFile = writeJson(root, 'durable-worker.json', durableWorker()).filePath
      const recoverySymlinkPath = path.join(root, 'recovery-link.json')
      const durableDirectoryPath = path.join(root, 'durable-directory')
      fs.symlinkSync(recoveryFile, recoverySymlinkPath)
      fs.mkdirSync(durableDirectoryPath)

      const symlinkResult = runCli(recoverySymlinkPath, verifierFile, durableFile)
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        reportKind: 'verifier_durable_operations_evidence',
        status: 'blocked',
        reason: 'recovery evidence must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        applied: false,
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'verifier_durable_operations_evidence_only'
      })

      const directoryResult = runCli(recoveryFile, verifierFile, durableDirectoryPath)
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        reportKind: 'verifier_durable_operations_evidence',
        status: 'blocked',
        reason: 'durable-worker evidence must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        authority: 'verifier_durable_operations_evidence_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects commit mismatches and sensitive contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-durable-safe-'))
    try {
      const recoveryFile = writeJson(root, 'recovery.json', recovery({ releaseCommit: 'b'.repeat(40) }))
      const verifierFile = writeJson(root, 'verifier-reconciliation.json', verifierReconciliation())
      const durableFile = writeJson(root, 'durable-worker.json', durableWorker())
      expect(() => buildVerifierDurableOperationsEvidence({ recoveryFile: recoveryFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'local_disposable', releaseCommit })).toThrow('does not match')
      const sensitiveFile = writeJson(root, 'sensitive.json', { ...recovery(), privateKey: 'never' })
      expect(() => buildVerifierDurableOperationsEvidence({ recoveryFile: sensitiveFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'local_disposable', releaseCommit })).toThrow('sensitive key')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces authenticated protected paths and authority safety', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-verifier-durable-auth-'))
    try {
      const recoveryFile = writeJson(root, 'recovery.json', recovery())
      const verifierFile = writeJson(root, 'verifier-reconciliation.json', verifierReconciliation())
      const durableFile = writeJson(root, 'durable-worker.json', durableWorker())
      expect(() => buildVerifierDurableOperationsEvidence({ recoveryFile: recoveryFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'authenticated_target', releaseCommit })).toThrow('must be inside the protected evidence root')
      const authorityFile = writeJson(root, 'authority.json', { ...recovery(), settlementAuthority: true })
      expect(() => buildVerifierDurableOperationsEvidence({ recoveryFile: authorityFile.filePath, verifierReconciliationFile: verifierFile.filePath, durableWorkerFile: durableFile.filePath, target: 'local_disposable', releaseCommit })).toThrow('immutable safety fields')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
