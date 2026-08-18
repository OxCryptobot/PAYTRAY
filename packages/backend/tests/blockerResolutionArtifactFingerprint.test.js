import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBlockerResolutionArtifactFingerprint } from '../scripts/verify-blocker-resolution-artifact-fingerprint.mjs'

const releaseCommit = 'a'.repeat(40)

function writeArtifact(root, name, overrides = {}) {
  const value = {
    reportKind: 'release_blocker_resolution',
    releaseCommit,
    operatorBlockerCount: 19,
    unexpectedFailureCount: 0,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...overrides
  }
  const artifactFile = path.join(root, name)
  const raw = JSON.stringify(value, null, 2)
  fs.writeFileSync(artifactFile, raw, { mode: 0o600 })
  const sidecarFile = `${artifactFile}.sha256`
  fs.writeFileSync(sidecarFile, `${createHash('sha256').update(raw, 'utf8').digest('hex')}  ${artifactFile}\n`, { mode: 0o600 })
  return { artifactFile, sidecarFile }
}

describe('blocker-resolution artifact fingerprint verifier', () => {
  it('verifies exact artifact and sidecar binding without authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-resolution-fingerprint-'))
    try {
      const files = writeArtifact(root, 'release-blocker-resolution.json')
      const report = buildBlockerResolutionArtifactFingerprint({ ...files, releaseCommit })
      expect(report).toMatchObject({ reportKind: 'release_blocker_resolution_fingerprint', status: 'verified_reference', artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/), operatorBlockerCount: 19, unexpectedFailureCount: 0, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects sidecar digest mismatch and commit mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-resolution-fingerprint-mismatch-'))
    try {
      const files = writeArtifact(root, 'release-blocker-resolution.json')
      fs.writeFileSync(files.sidecarFile, `${'b'.repeat(64)}  ${files.artifactFile}\n`)
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...files, releaseCommit })).toThrow('does not match sidecar')
      const matching = writeArtifact(root, 'release-blocker-resolution-commit.json', { releaseCommit: 'b'.repeat(40) })
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...matching, releaseCommit })).toThrow('does not match requested release commit')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed counts and authority-positive fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-resolution-fingerprint-safety-'))
    try {
      const malformed = writeArtifact(root, 'malformed.json', { operatorBlockerCount: -1 })
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...malformed, releaseCommit })).toThrow('operatorBlockerCount')
      const authority = writeArtifact(root, 'authority.json', { releaseEligible: true })
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...authority, releaseCommit })).toThrow('releaseEligible=true')
      const unsafeMutation = writeArtifact(root, 'mutation.json', { mutation: 'write' })
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...unsafeMutation, releaseCommit })).toThrow('unsafe mutation')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects wrong report kind and malformed sidecar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-resolution-fingerprint-schema-'))
    try {
      const wrongKind = writeArtifact(root, 'wrong-kind.json', { reportKind: 'release_gates' })
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...wrongKind, releaseCommit })).toThrow('reportKind')
      const malformed = writeArtifact(root, 'malformed-sidecar.json')
      fs.writeFileSync(malformed.sidecarFile, 'not-a-sidecar\n')
      expect(() => buildBlockerResolutionArtifactFingerprint({ ...malformed, releaseCommit })).toThrow('sidecar is malformed')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
