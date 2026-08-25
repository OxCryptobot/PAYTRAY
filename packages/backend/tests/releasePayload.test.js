import { spawnSync } from 'node:child_process'
import crypto from 'crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSignedReleasePayload, verifySignedReleasePayload } from '../lib/releasePayload.js'

const script = path.resolve(process.cwd(), 'scripts/verify-release-payload.mjs')

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

  it('rejects symlinked and non-regular CLI payload inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-release-payload-inputs-'))
    try {
      const payloadPath = path.join(root, 'payload.json')
      const symlinkPath = path.join(root, 'payload-link.json')
      const directoryPath = path.join(root, 'payload-directory')
      fs.writeFileSync(payloadPath, '{}', { mode: 0o600 })
      fs.symlinkSync(payloadPath, symlinkPath)
      fs.mkdirSync(directoryPath)

      const invoke = (filePath) => {
        const result = spawnSync(process.execPath, [script, filePath], {
          cwd: process.cwd(),
          encoding: 'utf8'
        })
        const serialized = (result.stderr || result.stdout).trim()
        return { status: result.status, output: JSON.parse(serialized) }
      }

      const symlinkResult = invoke(symlinkPath)
      expect(symlinkResult.status).toBe(1)
      expect(symlinkResult.output).toMatchObject({ status: 'blocked', reason: 'payload could not be parsed or read', mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
      expect(symlinkResult.output.error).toContain('must not be a symlink')

      const directoryResult = invoke(directoryPath)
      expect(directoryResult.status).toBe(1)
      expect(directoryResult.output).toMatchObject({ status: 'blocked', reason: 'payload could not be parsed or read', mutation: 'read_only' })
      expect(directoryResult.output.error).toContain('must be a regular file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
