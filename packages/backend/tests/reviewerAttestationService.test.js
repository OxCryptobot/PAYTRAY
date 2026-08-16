import { createHash } from 'node:crypto'
import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import { buildReviewerAttestationMessage, verifyReviewerAttestation } from '../lib/reviewerAttestationService.js'

const wallet = new Wallet('0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a3f9f5b6f7f6a3f1f1a')
const challenge = {
  id: '11111111-1111-4111-8111-111111111111',
  reviewer_wallet: wallet.address.toLowerCase(),
  role: 'security',
  release_commit: '090e837644d3cb6f4516ed10414e7603fed3d150',
  artifact_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  public_key_fingerprint_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  decision: 'approved',
  nonce: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  message_hash: null,
  issued_at: '2026-08-16T00:00:00.000Z',
  expires_at: '2099-08-16T00:15:00.000Z',
  consumed_at: null
}

function makeClient({ consumed = false } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT * FROM reviewer_attestation_challenges')) return { rows: [{ ...challenge, consumed_at: consumed ? '2026-08-16T00:01:00.000Z' : null }] }
      if (sql.startsWith('UPDATE reviewer_attestation_challenges')) return { rows: consumed ? [] : [{ id: challenge.id }] }
      if (sql.startsWith('INSERT INTO reviewer_attestations')) return { rows: [{ id: 'attestation-1', verified_at: '2026-08-16T00:02:00.000Z', created_at: '2026-08-16T00:02:00.000Z' }] }
      if (sql.startsWith('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-1' }] }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }
}

describe('reviewer attestation service', () => {
  it('recovers and binds the signature to the authenticated wallet and challenge fields', async () => {
    const message = buildReviewerAttestationMessage({
      challengeId: challenge.id,
      reviewerWallet: challenge.reviewer_wallet,
      role: challenge.role,
      releaseCommit: challenge.release_commit,
      artifactSha256: challenge.artifact_sha256,
      publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
      decision: challenge.decision,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.issued_at).toISOString(),
      expiresAt: new Date(challenge.expires_at).toISOString()
    })
    challenge.message_hash = createHash('sha256').update(message, 'utf8').digest('hex')
    const signature = await wallet.signMessage(message)
    const result = await verifyReviewerAttestation({ client: makeClient(), challengeId: challenge.id, signature, authenticatedWallet: wallet.address })
    expect(result).toMatchObject({ status: 'verified', reviewerWallet: wallet.address.toLowerCase(), role: 'security', releaseCommit: challenge.release_commit, decision: 'approved', applied: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.attestationDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects an authenticated wallet mismatch before accepting a signature', async () => {
    const signature = await wallet.signMessage('unused')
    await expect(verifyReviewerAttestation({ client: makeClient(), challengeId: challenge.id, signature, authenticatedWallet: '0x0000000000000000000000000000000000000001' })).rejects.toThrow('authenticated reviewer wallet does not match')
  })

  it('rejects a tampered challenge message hash', async () => {
    const message = buildReviewerAttestationMessage({
      challengeId: challenge.id,
      reviewerWallet: challenge.reviewer_wallet,
      role: challenge.role,
      releaseCommit: challenge.release_commit,
      artifactSha256: challenge.artifact_sha256,
      publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
      decision: challenge.decision,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.issued_at).toISOString(),
      expiresAt: new Date(challenge.expires_at).toISOString()
    })
    const signature = await wallet.signMessage(message)
    const tamperedClient = makeClient()
    tamperedClient.query = async (sql, params) => {
      if (sql.startsWith('SELECT * FROM reviewer_attestation_challenges')) return { rows: [{ ...challenge, message_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }] }
      return makeClient().query(sql, params)
    }
    await expect(verifyReviewerAttestation({ client: tamperedClient, challengeId: challenge.id, signature, authenticatedWallet: wallet.address })).rejects.toThrow('message hash mismatch')
  })

  it('rejects replayed challenges and does not insert an attestation', async () => {
    const message = buildReviewerAttestationMessage({
      challengeId: challenge.id,
      reviewerWallet: challenge.reviewer_wallet,
      role: challenge.role,
      releaseCommit: challenge.release_commit,
      artifactSha256: challenge.artifact_sha256,
      publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
      decision: challenge.decision,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.issued_at).toISOString(),
      expiresAt: new Date(challenge.expires_at).toISOString()
    })
    const signature = await wallet.signMessage(message)
    const client = makeClient({ consumed: true })
    await expect(verifyReviewerAttestation({ client, challengeId: challenge.id, signature, authenticatedWallet: wallet.address })).rejects.toThrow('already consumed')
    expect(client.calls.some(({ sql }) => sql.startsWith('INSERT INTO reviewer_attestations'))).toBe(false)
  })
})
