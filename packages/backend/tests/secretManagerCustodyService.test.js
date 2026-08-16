import { describe, expect, it } from 'vitest'
import { buildSecretManagerCustodyEvidence } from '../lib/secretManagerCustodyService.js'

function makeManifest(overrides = {}) {
  return {
    provider: 'approved-secret-manager',
    secretName: 'RELEASE_SIGNING_KEY_PEM',
    version: 'secret-version-8',
    privateKeyPresent: true,
    privateKeyExported: false,
    accessMode: 'ephemeral',
    publicKeyFingerprintSha256: 'a'.repeat(64),
    releaseCommit: 'b'.repeat(40),
    retrievedAt: '2026-08-16T12:00:00.000Z',
    ...overrides
  }
}

function makeEnv(overrides = {}) {
  return {
    RELEASE_SIGNING_KEY_PEM: 'test-only-secret-not-production',
    RELEASE_SIGNING_KEY_SECRET_NAME: 'RELEASE_SIGNING_KEY_PEM',
    RELEASE_SIGNING_KEY_SOURCE: 'approved-secret-manager',
    RELEASE_SIGNING_KEY_VERSION: 'secret-version-8',
    RELEASE_SIGNING_KEY_PROTECTED: 'true',
    RELEASE_SIGNING_KEY_PERSISTED: 'false',
    RELEASE_GIT_COMMIT: 'b'.repeat(40),
    ...overrides
  }
}

describe('secret-manager custody evidence', () => {
  it('verifies ephemeral injection and a redacted custody manifest without returning the secret', () => {
    const evidence = buildSecretManagerCustodyEvidence({ manifest: makeManifest(), env: makeEnv() })
    expect(evidence).toMatchObject({ status: 'verified', secretInjected: true, secretSource: 'approved-secret-manager', protectedSecret: true, persistedSecret: false, manifestPresent: true, manifestValid: true, ephemeralInjectionVerified: true, secretMaterialIncluded: false, privateKeyMaterialIncluded: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(JSON.stringify(evidence)).not.toContain('test-only-secret-not-production')
  })

  it('blocks missing injection and non-ephemeral persistence', () => {
    const evidence = buildSecretManagerCustodyEvidence({ manifest: makeManifest({ accessMode: 'persistent' }), env: makeEnv({ RELEASE_SIGNING_KEY_PEM: '', RELEASE_SIGNING_KEY_PERSISTED: 'true' }) })
    expect(evidence.status).toBe('blocked')
    expect(evidence.ephemeralInjectionVerified).toBe(false)
    expect(evidence.reasons).toEqual(expect.arrayContaining([
      'private key was not injected into the ephemeral release process',
      'private key persistence flag must not be true for ephemeral injection'
    ]))
  })

  it('rejects manifest fields that could contain secret or signature material', () => {
    const evidence = buildSecretManagerCustodyEvidence({ manifest: makeManifest({ privateKeyPem: 'forbidden' }), env: makeEnv() })
    expect(evidence.status).toBe('blocked')
    expect(evidence.manifestContainsSecretFields).toBe(true)
    expect(evidence.manifestSecretFieldPaths).toContain('$.privateKeyPem')
    expect(evidence.secretMaterialIncluded).toBe(false)
  })
})
