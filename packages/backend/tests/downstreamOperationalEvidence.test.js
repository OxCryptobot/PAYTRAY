import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDownstreamOperationalEvidence } from '../scripts/verify-downstream-operational-evidence.mjs'

const releaseCommit = 'a'.repeat(40)
const script = path.resolve(process.cwd(), 'scripts/verify-downstream-operational-evidence.mjs')
const targetCheckNames = ['deploymentConfiguration', 'railwayTrialUrl', 'railwaySettings', 'database', 'paymentRpc', 'baseSepoliaPolicy', 'verifierWorker', 'outboxWorker', 'idempotencyHousekeeping']

function runCli(targetOperationsFile, tokenMetadataFile) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DOWNSTREAM_TARGET_OPERATIONS_FILE: targetOperationsFile,
      DOWNSTREAM_TOKEN_METADATA_FILE: tokenMetadataFile,
      DOWNSTREAM_EVIDENCE_TARGET: 'local_disposable',
      DOWNSTREAM_EVIDENCE_COMMIT: releaseCommit
    }
  })
}

function writeJson(root, name, value) {
  const filePath = path.join(root, name)
  const raw = JSON.stringify(value)
  fs.writeFileSync(filePath, raw, { mode: 0o600 })
  return { filePath, sha256: createHash('sha256').update(raw).digest('hex') }
}

function targetOperations(overrides = {}) {
  return {
    reportKind: 'target_operations_evidence',
    status: 'ready',
    releaseCommit,
    deploymentTarget: 'railway-trial',
    checks: targetCheckNames.map((name) => ({ name, ready: true, reason: 'ready' })),
    blockers: [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...overrides
  }
}

function tokenMetadata(overrides = {}) {
  return {
    reportKind: 'token_metadata_evidence',
    status: 'matched',
    chainId: 84532,
    actualChainId: 84532,
    tokens: [{ address: '0x1111111111111111111111111111111111111111', status: 'matched', decimalsMatch: true, symbolMatch: true }],
    authority: 'read_only_rpc_metadata',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    releaseCommit,
    ...overrides
  }
}

describe('downstream operational evidence verifier', () => {
  it('verifies target operations and token metadata as a non-authoritative reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-evidence-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations())
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata())
      const result = buildDownstreamOperationalEvidence({ targetOperationsFile: target.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ reportKind: 'downstream_operational_evidence', status: 'verified_reference', evidenceCount: 2, verifiedReferenceCount: 2, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ blocker: 'target-operations', status: 'verified_reference' }), expect.objectContaining({ blocker: 'token-metadata', status: 'verified_reference' })]))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps incomplete downstream evidence blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-blocked-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations({ checks: targetCheckNames.map((name) => ({ name, ready: name !== 'railwaySettings', reason: 'blocked' })) }))
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata({ status: 'blocked', tokens: [{ address: '0x1111111111111111111111111111111111111111', status: 'mismatch', decimalsMatch: false, symbolMatch: true }] }))
      const result = buildDownstreamOperationalEvidence({ targetOperationsFile: target.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(result.blockers.every((blocker) => blocker.status === 'blocked')).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and non-regular direct inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-inputs-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations()).filePath
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata()).filePath
      const targetSymlinkPath = path.join(root, 'target-operations-link.json')
      const metadataDirectoryPath = path.join(root, 'token-metadata-directory')
      fs.symlinkSync(target, targetSymlinkPath)
      fs.mkdirSync(metadataDirectoryPath)

      const symlinkResult = runCli(targetSymlinkPath, metadata)
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        reportKind: 'downstream_operational_evidence',
        status: 'blocked',
        reason: 'target operations evidence must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        applied: false,
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'downstream_operational_evidence_only'
      })

      const directoryResult = runCli(target, metadataDirectoryPath)
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        reportKind: 'downstream_operational_evidence',
        status: 'blocked',
        reason: 'token metadata evidence must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        authority: 'downstream_operational_evidence_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects mismatched commits and sensitive contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-safe-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations({ releaseCommit: 'b'.repeat(40) }))
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata())
      expect(() => buildDownstreamOperationalEvidence({ targetOperationsFile: target.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })).toThrow('does not match')
      const sensitive = writeJson(root, 'sensitive.json', { ...targetOperations(), privateKey: 'never' })
      expect(() => buildDownstreamOperationalEvidence({ targetOperationsFile: sensitive.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })).toThrow('sensitive key')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces protected paths for authenticated target evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-auth-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations())
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata())
      expect(() => buildDownstreamOperationalEvidence({ targetOperationsFile: target.filePath, tokenMetadataFile: metadata.filePath, target: 'authenticated_target', releaseCommit })).toThrow('must be inside the protected evidence root')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects authority-positive or unsafe mutation fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-downstream-authority-'))
    try {
      const target = writeJson(root, 'target-operations.json', targetOperations({ settlementAuthority: true }))
      const metadata = writeJson(root, 'token-metadata.json', tokenMetadata())
      expect(() => buildDownstreamOperationalEvidence({ targetOperationsFile: target.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })).toThrow('immutable safety fields')
      const unsafeTarget = writeJson(root, 'unsafe-target-operations.json', targetOperations({ mutation: 'write' }))
      expect(() => buildDownstreamOperationalEvidence({ targetOperationsFile: unsafeTarget.filePath, tokenMetadataFile: metadata.filePath, target: 'local_disposable', releaseCommit })).toThrow('unsafe mutation')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
