import crypto from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildSignedReleasePayload, verifySignedReleasePayload } from '../lib/releasePayload.js'

function keyPair() {
  return crypto.generateKeyPairSync('ed25519')
}

const base = {
  manifest: { status: 'ready', manifestHash: 'a'.repeat(64) },
  approval: { status: 'approved', eligible: true },
  railway: { status: 'matched' },
  migration: { status: 'passed' },
  recovery: { status: 'verified' }
}

describe('signed release payload', () => {
  it('signs and verifies a complete release evidence set without mutation authority', () => {
    const pair = keyPair()
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const payload = buildSignedReleasePayload({ ...base, signer: { privateKeyPem } })
    expect(payload).toMatchObject({ status: 'ready', algorithm: 'ed25519', deploymentPerformed: false, settlementMutationPerformed: false, mutation: 'read_only' })
    expect(verifySignedReleasePayload(payload)).toBe(true)
  })

  it('blocks signing readiness when recovery or Railway evidence is incomplete', () => {
    const pair = keyPair()
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const payload = buildSignedReleasePayload({ ...base, railway: { status: 'unavailable' }, recovery: { status: 'schema_catalog_only' }, signer: { privateKeyPem } })
    expect(payload.status).toBe('blocked')
    expect(payload.signature).toBeTruthy()
    expect(verifySignedReleasePayload(payload)).toBe(false)
  })

  it('rejects a signed payload when the evidence envelope is changed after signing', () => {
    const pair = keyPair()
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const payload = buildSignedReleasePayload({ ...base, signer: { privateKeyPem } })
    payload.evidence.approval.reviewerId = 'tampered'
    expect(verifySignedReleasePayload(payload)).toBe(false)
  })

  it('remains blocked without a signing key', () => {
    const payload = buildSignedReleasePayload(base)
    expect(payload).toMatchObject({ status: 'blocked', signature: null, publicKeyPem: null })
  })
})
