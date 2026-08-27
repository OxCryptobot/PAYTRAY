import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSecretManagerCustodyEvidence, loadSecretManagerCustodyManifest } from '../lib/secretManagerCustodyService.js'

const verifierScript = fileURLToPath(new URL('../scripts/verify-secret-manager-custody.mjs', import.meta.url))

function runVerifierCli(env) {
  const result = spawnSync(process.execPath, [verifierScript], { env: { ...process.env, ...env }, encoding: 'utf8' })
  const output = result.stdout || result.stderr
  return { ...result, report: JSON.parse(output) }
}

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

  it('validates the original manifest path before reading or parsing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-secret-manager-manifest-'))
    try {
      const manifestFile = path.join(root, 'manifest.json')
      const symlinkFile = path.join(root, 'manifest-link.json')
      const danglingFile = path.join(root, 'manifest-dangling.json')
      const directory = path.join(root, 'manifest-directory')
      fs.writeFileSync(manifestFile, JSON.stringify(makeManifest()) + '\n')
      fs.symlinkSync(manifestFile, symlinkFile)
      fs.symlinkSync(path.join(root, 'missing.json'), danglingFile)
      fs.mkdirSync(directory)

      await expect(loadSecretManagerCustodyManifest(manifestFile)).resolves.toMatchObject({ provider: 'approved-secret-manager' })
      await expect(loadSecretManagerCustodyManifest(symlinkFile)).rejects.toThrow('secret-manager custody manifest file must not be a symlink')
      await expect(loadSecretManagerCustodyManifest(danglingFile)).rejects.toThrow('secret-manager custody manifest file must not be a symlink')
      await expect(loadSecretManagerCustodyManifest(directory)).rejects.toThrow('secret-manager custody manifest file must be a regular file')
      await expect(loadSecretManagerCustodyManifest(path.join(root, 'missing.json'))).rejects.toThrow(/ENOENT/)

      const accepted = runVerifierCli({ RELEASE_SIGNING_CUSTODY_MANIFEST_FILE: manifestFile })
      expect(accepted.status).toBe(1)
      expect(accepted.report).toMatchObject({ status: 'blocked', manifestPresent: true, secretMaterialIncluded: false, privateKeyMaterialIncluded: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, authority: 'secret_manager_custody_evidence_only' })

      for (const input of [symlinkFile, danglingFile, directory]) {
        const blocked = runVerifierCli({ RELEASE_SIGNING_CUSTODY_MANIFEST_FILE: input })
        expect(blocked.status).toBe(1)
        expect(blocked.report).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, authority: 'secret_manager_custody_evidence_only' })
        expect(blocked.report.reason).toMatch(/must not be a symlink|must be a regular file/)
        expect(JSON.stringify(blocked.report)).not.toContain('approved-secret-manager')
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
