import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateReviewerAttestationBundle } from '../scripts/verify-reviewer-attestation-bundle.mjs'

const script = path.resolve(process.cwd(), 'scripts/verify-reviewer-attestation-bundle.mjs')
const releaseCommit = 'a'.repeat(40)
const artifactSha256 = 'b'.repeat(64)
const publicKeyFingerprintSha256 = 'c'.repeat(64)
const roles = ['release_operator', 'protocol_finance', 'ai_data', 'security']

function bundle() {
  return {
    status: 'ok',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    attestations: roles.map((role, index) => ({
      role,
      reviewerWallet: `0x${String(index + 1).padStart(40, '0')}`,
      releaseCommit,
      artifactSha256,
      publicKeyFingerprintSha256,
      decision: 'approved',
      applied: false,
      releaseEligible: false,
      settlementAuthority: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      mutation: 'read_only'
    }))
  }
}

function runCli(filePath) {
  return spawnSync(process.execPath, [script, filePath], { encoding: 'utf8', env: process.env })
}

describe('reviewer-attestation bundle verifier', () => {
  it('validates four distinct commit-bound attestations without granting authority', () => {
    const result = validateReviewerAttestationBundle({ content: bundle() })
    expect(result).toMatchObject({
      status: 'verified',
      count: 4,
      roles,
      releaseCommit,
      artifactSha256,
      publicKeyFingerprintSha256,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'reviewer_attestation_bundle_verification_only'
    })
  })

  it('rejects symlinked and non-regular bundle inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-reviewer-bundle-inputs-'))
    try {
      const reportPath = path.join(root, 'attestations.json')
      const symlinkPath = path.join(root, 'attestations-link.json')
      const directoryPath = path.join(root, 'attestations-directory')
      fs.writeFileSync(reportPath, `${JSON.stringify(bundle())}\n`, { mode: 0o600 })
      fs.symlinkSync(reportPath, symlinkPath)
      fs.mkdirSync(directoryPath)

      const symlinkResult = runCli(symlinkPath)
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'reviewer attestation bundle file must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        applied: false,
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'reviewer_attestation_bundle_verification_only'
      })

      const directoryResult = runCli(directoryPath)
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'reviewer attestation bundle file must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        authority: 'reviewer_attestation_bundle_verification_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unsafe authority and sensitive fields in bundle content', () => {
    expect(() => validateReviewerAttestationBundle({ content: { ...bundle(), releaseEligible: true } })).toThrow('immutable authority violation')
    expect(() => validateReviewerAttestationBundle({ content: { ...bundle(), reviewerNotes: 'hidden' } })).toThrow('sensitive key')
  })
})
