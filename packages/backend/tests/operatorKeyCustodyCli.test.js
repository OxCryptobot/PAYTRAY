import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const script = path.resolve(process.cwd(), 'scripts/verify-operator-key-custody.mjs')

describe('operator key custody CLI', () => {
  it('verifies a complete test-only custody packet without emitting key material', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
    const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex')
    const releaseCommit = 'a'.repeat(40)
    const directory = await mkdtemp(path.join(tmpdir(), 'paytray-key-custody-'))
    const attestationPath = path.join(directory, 'fingerprint-attestation.json')
    await writeFile(attestationPath, JSON.stringify({
      role: 'security',
      verifiedBy: 'security-reviewer@paytray.invalid',
      attestationId: 'security-attestation-test',
      verifiedAt: '2026-08-16T12:00:00.000Z',
      publicKeyFingerprintSha256: fingerprint,
      releaseCommit
    }), { mode: 0o600 })

    const { stdout } = await execFile('node', [script], {
      env: {
        ...process.env,
        RELEASE_SIGNING_KEY_PEM: privateKeyPem,
        RELEASE_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
        RELEASE_SIGNING_PUBLIC_KEY_SHA256: fingerprint,
        RELEASE_SIGNING_PUBLIC_KEY_FINGERPRINT_VERIFIED: 'true',
        RELEASE_SIGNING_FINGERPRINT_ATTESTATION_FILE: attestationPath,
        RELEASE_SIGNING_KEY_SOURCE: 'approved-secret-manager',
        RELEASE_SIGNING_KEY_VERSION: 'version-test-only',
        RELEASE_SIGNING_KEY_PROTECTED: 'true',
        RELEASE_GIT_COMMIT: releaseCommit
      }
    })
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ status: 'verified', custodyVerified: true, independentVerification: true, fingerprintMatchesExpected: true, privateKeyMaterialIncluded: false, publicKeyMaterialIncluded: false, releaseEligible: false, settlementAuthority: false })
    expect(stdout).not.toContain(privateKeyPem)
    expect(stdout).not.toContain(publicKeyPem)
  })
})
