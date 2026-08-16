import { createHash, generateKeyPairSync } from 'node:crypto'
import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import { buildFingerprintAttestationMessage, buildOperatorKeyCustodyEvidence } from '../lib/operatorKeyCustodyService.js'

async function makeKeyEvidence(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex')
  const releaseCommit = 'a'.repeat(40)
  const keyVersion = 'secret-version-7'
  const secretName = 'RELEASE_SIGNING_KEY_PEM'
  const securityWallet = Wallet.createRandom()
  const message = buildFingerprintAttestationMessage({ releaseCommit, publicKeyFingerprintSha256: fingerprint, secretName, keyVersion })
  const signature = await securityWallet.signMessage(message)
  return {
    privateKeyPem,
    publicKeyPem,
    expectedPublicKeyFingerprintSha256: fingerprint,
    releaseCommit,
    privateKeySource: 'approved-secret-manager',
    keyVersion,
    secretName,
    protectedSecret: true,
    independentlyVerifiedFlag: true,
    custodyManifest: {
      provider: 'approved-secret-manager',
      secretName,
      version: keyVersion,
      privateKeyPresent: true,
      privateKeyExported: false,
      accessMode: 'ephemeral',
      publicKeyFingerprintSha256: fingerprint,
      releaseCommit,
      retrievedAt: '2026-08-16T12:00:00.000Z'
    },
    fingerprintAttestation: {
      role: 'security',
      verifiedBy: securityWallet.address,
      reviewerWallet: securityWallet.address,
      attestationId: 'security-attestation-7',
      verifiedAt: '2026-08-16T12:00:00.000Z',
      publicKeyFingerprintSha256: fingerprint,
      releaseCommit,
      secretName,
      keyVersion,
      message,
      signature
    },
    ...overrides
  }
}

describe('operator key custody evidence', () => {
  it('verifies matching Ed25519 custody and independently signed fingerprint evidence without exposing key material', async () => {
    const input = await makeKeyEvidence()
    const evidence = buildOperatorKeyCustodyEvidence(input)
    expect(evidence).toMatchObject({ status: 'verified', privateKeyPresent: true, publicKeyPresent: true, privateKeyAlgorithm: 'ed25519', publicKeyAlgorithm: 'ed25519', custodyVerified: true, custodyManifestVerified: true, derivedPublicKeyMatches: true, fingerprintMatchesExpected: true, independentAttestationSignatureVerified: true, independentVerification: true, attestationRole: 'security', privateKeyMaterialIncluded: false, publicKeyMaterialIncluded: false, signatureMaterialIncluded: false, custodyManifestMaterialIncluded: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(JSON.stringify(evidence)).not.toContain(input.privateKeyPem)
    expect(JSON.stringify(evidence)).not.toContain(input.publicKeyPem)
    expect(JSON.stringify(evidence)).not.toContain(input.fingerprintAttestation.signature)
    expect(evidence.calculatedPublicKeyFingerprintSha256).toBe(input.expectedPublicKeyFingerprintSha256)
  })

  it('blocks a fingerprint mismatch, even when the private key is protected and parseable', async () => {
    const evidence = buildOperatorKeyCustodyEvidence(await makeKeyEvidence({ expectedPublicKeyFingerprintSha256: 'b'.repeat(64) }))
    expect(evidence.status).toBe('blocked')
    expect(evidence.fingerprintMatchesExpected).toBe(false)
    expect(evidence.releaseEligible).toBe(false)
    expect(evidence.reasons).toContain('public-key fingerprint does not match the operator-supplied expected fingerprint')
  })

  it('blocks missing independent security verification and placeholder custody metadata', async () => {
    const input = await makeKeyEvidence({ independentlyVerifiedFlag: false, keyVersion: '<secret-version>', custodyManifest: null, fingerprintAttestation: null })
    const evidence = buildOperatorKeyCustodyEvidence(input)
    expect(evidence.status).toBe('blocked')
    expect(evidence.independentVerification).toBe(false)
    expect(evidence.custodyVerified).toBe(false)
    expect(evidence.reasons).toEqual(expect.arrayContaining([
      'secret-manager custody manifest is missing, mismatched, exported, or not ephemeral',
      'independent security fingerprint signature is missing or does not match the key, custody manifest, or release commit',
      'independent fingerprint verification flag is not true'
    ]))
  })

  it('rejects an attestation signed by a different wallet', async () => {
    const input = await makeKeyEvidence()
    const otherWallet = Wallet.createRandom()
    input.fingerprintAttestation.signature = await otherWallet.signMessage(input.fingerprintAttestation.message)
    const evidence = buildOperatorKeyCustodyEvidence(input)
    expect(evidence.status).toBe('blocked')
    expect(evidence.independentAttestationSignatureVerified).toBe(false)
  })
})
