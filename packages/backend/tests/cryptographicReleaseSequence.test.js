import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCryptographicReleaseSequence } from '../scripts/verify-cryptographic-release-sequence.mjs'

const releaseCommit = 'a'.repeat(40)
const artifactSha256 = 'b'.repeat(64)
const publicKeyFingerprintSha256 = 'c'.repeat(64)
const roles = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const script = path.resolve(process.cwd(), 'scripts/verify-cryptographic-release-sequence.mjs')

function writeJson(root, name, value) {
  const filePath = path.join(root, name)
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 })
  return filePath
}

function runCli(files) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CRYPTO_RELEASE_EVIDENCE_FILE: files.releaseEvidence,
      CRYPTO_ATTESTATION_BUNDLE_FILE: files.attestationBundle,
      CRYPTO_OPERATOR_KEY_CUSTODY_FILE: files.operatorKeyCustody,
      CRYPTO_SECRET_MANAGER_CUSTODY_FILE: files.secretManagerCustody,
      CRYPTO_RELEASE_MANIFEST_FILE: files.releaseManifest,
      CRYPTO_RELEASE_PAYLOAD_FILE: files.signedPayload,
      CRYPTO_RELEASE_COMMIT: releaseCommit,
      CRYPTO_ARTIFACT_SHA256: artifactSha256,
      CRYPTO_PUBLIC_KEY_FINGERPRINT_SHA256: publicKeyFingerprintSha256,
      CRYPTO_SEQUENCE_TARGET: 'local_disposable'
    }
  })
}

function evidence(overrides = {}) {
  return {
    releaseEvidence: {
      humanSignoffs: { complete: true },
      reviewerAttestationSummary: { complete: true },
      signingKeyEvidence: { ready: true },
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseEvidence
    },
    attestationBundle: {
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
      ...overrides.attestationBundle
    },
    operatorKeyCustody: {
      status: 'verified',
      releaseCommit,
      calculatedPublicKeyFingerprintSha256: publicKeyFingerprintSha256,
      independentVerification: true,
      independentAttestationSignatureVerified: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.operatorKeyCustody
    },
    secretManagerCustody: {
      status: 'verified',
      releaseCommit,
      publicKeyFingerprintSha256,
      ephemeralInjectionVerified: true,
      privateKeyMaterialIncluded: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.secretManagerCustody
    },
    releaseManifest: {
      status: 'ready',
      gitCommit: releaseCommit,
      artifacts: [{ path: 'server.js', sha256: artifactSha256 }],
      manifestHash: 'd'.repeat(64),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseManifest
    },
    signedPayload: {
      status: 'verified',
      signatureValid: true,
      evidenceReady: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.signedPayload
    },
    releaseCommit,
    artifactSha256,
    publicKeyFingerprintSha256,
    target: 'local_disposable'
  }
}

describe('cryptographic release sequence', () => {
  it('verifies all cryptographic evidence while never granting authority', () => {
    const result = buildCryptographicReleaseSequence(evidence())
    expect(result).toMatchObject({ status: 'verified', cryptographicSequenceComplete: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toEqual([])
    expect(result.steps).toHaveLength(5)
  })

  it('lists all missing cryptographic prerequisites without throwing', () => {
    const result = buildCryptographicReleaseSequence(evidence({
      releaseEvidence: { humanSignoffs: { complete: false }, reviewerAttestationSummary: { complete: false }, signingKeyEvidence: { ready: false } },
      attestationBundle: { status: 'blocked', count: 0, roles: [] },
      operatorKeyCustody: { status: 'blocked', independentVerification: false, independentAttestationSignatureVerified: false },
      secretManagerCustody: { status: 'blocked', ephemeralInjectionVerified: false },
      releaseManifest: { status: 'blocked' },
      signedPayload: { status: 'blocked', signatureValid: false, evidenceReady: false }
    }))
    expect(result.status).toBe('blocked')
    expect(result.blockers.map((blocker) => blocker.step)).toEqual(expect.arrayContaining(['release-evidence', 'reviewer-attestation-bundle', 'operator-key-and-secret-manager-custody', 'release-manifest', 'signed-release-payload']))
  })

  it('blocks mismatched commit and fingerprint bindings', () => {
    const commitResult = buildCryptographicReleaseSequence(evidence({ attestationBundle: { releaseCommit: 'e'.repeat(40) } }))
    expect(commitResult.status).toBe('blocked')
    expect(commitResult.blockers).toContainEqual({ step: 'reviewer-attestation-bundle', reason: 'attestation bundle commit does not match' })
    const fingerprintResult = buildCryptographicReleaseSequence(evidence({ operatorKeyCustody: { calculatedPublicKeyFingerprintSha256: 'f'.repeat(64) } }))
    expect(fingerprintResult.status).toBe('blocked')
    expect(fingerprintResult.blockers).toContainEqual({ step: 'operator-key-and-secret-manager-custody', reason: 'derived public-key fingerprint does not match' })
  })

  it('rejects symlinked and non-regular direct inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-cryptographic-sequence-inputs-'))
    try {
      const values = evidence()
      const files = Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'releaseCommit' && key !== 'artifactSha256' && key !== 'publicKeyFingerprintSha256' && key !== 'target').map(([key, value]) => [key, writeJson(root, `${key}.json`, value)]))
      const releaseEvidenceSymlink = path.join(root, 'release-evidence-link.json')
      const signedPayloadDirectory = path.join(root, 'signed-payload-directory')
      fs.symlinkSync(files.releaseEvidence, releaseEvidenceSymlink)
      fs.mkdirSync(signedPayloadDirectory)

      const symlinkResult = runCli({ ...files, releaseEvidence: releaseEvidenceSymlink })
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'cryptographic release evidence must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        applied: false,
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'cryptographic_release_sequence_evidence_only'
      })

      const directoryResult = runCli({ ...files, signedPayload: signedPayloadDirectory })
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'cryptographic signed payload must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        authority: 'cryptographic_release_sequence_evidence_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects sensitive raw signature or key material', () => {
    expect(() => buildCryptographicReleaseSequence(evidence({ signedPayload: { signature: '0xraw' } }))).toThrow('sensitive keys')
    expect(() => buildCryptographicReleaseSequence(evidence({ operatorKeyCustody: { privateKeyPem: 'forbidden' } }))).toThrow('sensitive keys')
  })

  it('rejects authority violations in any source evidence', () => {
    expect(() => buildCryptographicReleaseSequence(evidence({ releaseEvidence: { releaseEligible: true } }))).toThrow('authority or mutation violation')
    expect(() => buildCryptographicReleaseSequence(evidence({ signedPayload: { mutation: 'write' } }))).toThrow('authority or mutation violation')
  })
})
