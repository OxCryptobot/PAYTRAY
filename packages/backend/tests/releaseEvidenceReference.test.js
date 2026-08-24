import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSmokePhase2Evidence } from '../scripts/verify-smoke-phase2-evidence.mjs'
import { buildReleaseEvidenceReference } from '../scripts/verify-release-evidence-reference.mjs'

const releaseCommit = 'c'.repeat(40)

function writeJson(root, name, value) {
  const file = path.join(root, name)
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
  return file
}

function smokeReport(overrides = {}) {
  return {
    reportKind: 'smoke_phase2_evidence',
    status: 'ok',
    releaseCommit,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'controlled_smoke_evidence',
    experts: 1,
    outcomeReplay: true,
    smokeBoundary: {
      isolatedDatabase: true,
      chainId: 84532,
      mainnetEnabled: false,
      tokenAddress: `0x${'1'.repeat(40)}`,
      chainTransactionSubmitted: false,
      settlementMutationPerformed: false
    },
    ...overrides
  }
}

function releaseEnvelope(overrides = {}) {
  const names = ['targetOperations', 'deploymentPreflight', 'database', 'verifierOperations', 'reconciliation', 'outbox', 'webhookInbox', 'shadowReviews', 'rollbackTargets', 'humanSignoffs', 'reviewerAttestations', 'signingKey']
  const checks = names.map((name) => ({ name, ready: false, reason: `${name} is blocked`, evidence: null }))
  return {
    reportKind: 'release_evidence',
    status: 'blocked',
    bundle: {
      releaseCommit,
      evidenceComplete: false,
      releaseEligible: false,
      settlementAuthority: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      mutation: 'read_only',
      promotionStatus: 'shadow_only',
      approvalRequired: true,
      authority: 'release_evidence_aggregation_only',
      signingKeyMaterialIncluded: false,
      checks,
      evidenceFingerprint: { algorithm: 'sha256', kind: 'release_evidence', value: 'd'.repeat(64) },
      ...overrides
    }
  }
}

describe('smoke-phase2 evidence verifier', () => {
  it('verifies isolated Base Sepolia no-mutation smoke evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-smoke-evidence-'))
    try {
      const file = writeJson(root, 'smoke.json', smokeReport())
      const result = buildSmokePhase2Evidence({ evidenceFile: file, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ status: 'verified_reference', target: 'local_disposable', releaseCommit, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(result.checks).toEqual(expect.objectContaining({ isolatedDatabase: true, baseSepolia: true, chainTransactionNotSubmitted: true, settlementNotMutated: true }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks chain submission, sensitive raw payloads, and commit mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-smoke-evidence-blocked-'))
    try {
      const submitted = writeJson(root, 'submitted.json', smokeReport({ smokeBoundary: { ...smokeReport().smokeBoundary, chainTransactionSubmitted: true } }))
      const submittedResult = buildSmokePhase2Evidence({ evidenceFile: submitted, target: 'local_disposable', releaseCommit })
      expect(submittedResult.status).toBe('blocked')
      expect(submittedResult.checks.chainTransactionNotSubmitted).toBe(false)
      const rawPayload = writeJson(root, 'raw-payload.json', smokeReport({ rawPayload: { body: 'not allowed' } }))
      expect(() => buildSmokePhase2Evidence({ evidenceFile: rawPayload, target: 'local_disposable', releaseCommit })).toThrow('sensitive')
      const mismatch = writeJson(root, 'mismatch.json', smokeReport({ releaseCommit: 'd'.repeat(40) }))
      expect(() => buildSmokePhase2Evidence({ evidenceFile: mismatch, target: 'local_disposable', releaseCommit })).toThrow('does not match')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('release-evidence reference verifier', () => {
  it('verifies a complete-shaped but still non-authoritative release-evidence bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-release-evidence-'))
    try {
      const file = writeJson(root, 'release.json', releaseEnvelope())
      const result = buildReleaseEvidenceReference({ evidenceFile: file, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ status: 'verified_reference', reportKind: 'release_evidence_reference_verification', releaseEligible: false, settlementAuthority: false, authority: 'release_evidence_aggregation_only' })
      expect(result.fingerprintValid).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects missing checks, unsafe authority, sensitive key names, and commit mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-release-evidence-blocked-'))
    try {
      const missing = writeJson(root, 'missing.json', releaseEnvelope({ checks: [] }))
      expect(() => buildReleaseEvidenceReference({ evidenceFile: missing, target: 'local_disposable', releaseCommit })).toThrow('exactly the required')
      const unsafe = writeJson(root, 'unsafe.json', releaseEnvelope({ releaseEligible: true }))
      expect(() => buildReleaseEvidenceReference({ evidenceFile: unsafe, target: 'local_disposable', releaseCommit })).toThrow('immutable')
      const sensitive = writeJson(root, 'sensitive.json', releaseEnvelope({ privateKey: 'never' }))
      expect(() => buildReleaseEvidenceReference({ evidenceFile: sensitive, target: 'local_disposable', releaseCommit })).toThrow('sensitive')
      const mismatch = writeJson(root, 'mismatch.json', releaseEnvelope({ releaseCommit: 'd'.repeat(40) }))
      expect(() => buildReleaseEvidenceReference({ evidenceFile: mismatch, target: 'local_disposable', releaseCommit })).toThrow('does not match')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and non-regular release-evidence inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-release-evidence-inputs-'))
    try {
      const reportPath = writeJson(root, 'release.json', releaseEnvelope())
      const symlinkPath = path.join(root, 'release-link.json')
      const directoryPath = path.join(root, 'release-directory')
      fs.symlinkSync(reportPath, symlinkPath)
      fs.mkdirSync(directoryPath)

      expect(() => buildReleaseEvidenceReference({ evidenceFile: symlinkPath, target: 'local_disposable', releaseCommit })).toThrow('must not be a symlink')
      expect(() => buildReleaseEvidenceReference({ evidenceFile: directoryPath, target: 'local_disposable', releaseCommit })).toThrow('must be a regular file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
