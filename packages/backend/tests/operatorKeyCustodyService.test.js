import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildOperatorKeyCustodyEvidence } from '../lib/operatorKeyCustodyService.js'

function makeKeyEvidence(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex')
  const releaseCommit = 'a'.repeat(40)
  return {
    privateKeyPem,
    publicKeyPem,
    expectedPublicKeyFingerprintSha256: fingerprint,
    releaseCommit,
    privateKeySource: 'approved-secret-manager',
    keyVersion: 'secret-version-7',
    protectedSecret: true,
    independentlyVerifiedFlag: true,
    fingerprintAttestation: {
      role: 'security',
      verifiedBy: 'security-reviewer@paytray.invalid',
      attestationId: 'security-attestation-7',
      verifiedAt: '2026-08-16T12:00:00.000Z',
      publicKeyFingerprintSha256: fingerprint,
      releaseCommit
    },
    ...overrides
  }
}

describe('operator key custody evidence', () => {
  it('verifies matching Ed25519 custody and independent fingerprint attestation without exposing key material', () => {
    const input = makeKeyEvidence()
    const evidence = buildOperatorKeyCustodyEvidence(input)
    expect(evidence).toMatchObject({ status: 'verified', privateKeyPresent: true, publicKeyPresent: true, privateKeyAlgorithm: 'ed25519', publicKeyAlgorithm: 'ed25519', custodyVerified: true, derivedPublicKeyMatches: true, fingerprintMatchesExpected: true, independentVerification: true, attestationRole: 'security', privateKeyMaterialIncluded: false, publicKeyMaterialIncluded: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(JSON.stringify(evidence)).not.toContain(input.privateKeyPem)
    expect(evidence.calculatedPublicKeyFingerprintSha256).toBe(input.expectedPublicKeyFingerprintSha256)
  })

  it('blocks a fingerprint mismatch, even when the private key is protected and parseable', () => {
    const evidence = buildOperatorKeyCustodyEvidence(makeKeyEvidence({ expectedPublicKeyFingerprintSha256: 'b'.repeat(64) }))
    expect(evidence.status).toBe('blocked')
    expect(evidence.fingerprintMatchesExpected).toBe(false)
    expect(evidence.releaseEligible).toBe(false)
    expect(evidence.reasons).toContain('public-key fingerprint does not match the operator-supplied expected fingerprint')
  })

  it('blocks missing independent security verification and placeholder custody metadata', () => {
    const input = makeKeyEvidence({ independentlyVerifiedFlag: false, keyVersion: '<secret-version>', fingerprintAttestation: null })
    const evidence = buildOperatorKeyCustodyEvidence(input)
    expect(evidence.status).toBe('blocked')
    expect(evidence.independentVerification).toBe(false)
    expect(evidence.custodyVerified).toBe(false)
    expect(evidence.reasons).toEqual(expect.arrayContaining([
      'independent security fingerprint attestation is missing or does not match the key and release commit',
      'private-key custody is not verified against the approved secret-manager contract',
      'independent fingerprint verification flag is not true'
    ]))
  })
})
