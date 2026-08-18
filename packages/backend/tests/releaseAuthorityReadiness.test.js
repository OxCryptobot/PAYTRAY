import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseAuthorityReadiness } from '../scripts/verify-release-authority-readiness.mjs'

const script = path.resolve(process.cwd(), 'scripts/verify-release-authority-readiness.mjs')

function runCli(env = {}) {
  return spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: 'utf8' })
}

function writeEvidenceFiles(root, fixture) {
  const files = {}
  for (const [name, value] of Object.entries(fixture)) {
    const filePath = path.join(root, `${name}.json`)
    fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 })
    files[name] = filePath
  }
  return files
}

const releaseCommit = 'a'.repeat(40)

function evidence(overrides = {}) {
  return {
    releaseApproval: {
      status: 'approved',
      eligible: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseApproval
    },
    releaseEvidence: {
      evidenceComplete: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.releaseEvidence
    },
    shadowReviewStatus: {
      status: 'complete',
      expectedRunCount: 6,
      observedRunCount: 6,
      pendingCount: 0,
      terminalCount: 6,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.shadowReviewStatus
    },
    cryptographicSequence: {
      status: 'verified',
      cryptographicSequenceComplete: true,
      releaseCommit,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      ...overrides.cryptographicSequence
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
    target: 'local_disposable'
  }
}

describe('release authority readiness', () => {
  it('requires all genuine evidence but never grants release authority', () => {
    const result = buildReleaseAuthorityReadiness(evidence())
    expect(result).toMatchObject({ status: 'ready_for_controlled_release_evaluation', readyForControlledEvaluation: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toEqual([])
  })

  it('blocks missing sign-offs and pending shadow reviews', () => {
    const result = buildReleaseAuthorityReadiness(evidence({
      releaseApproval: { status: 'blocked', eligible: false },
      releaseEvidence: { evidenceComplete: false },
      shadowReviewStatus: { status: 'pending_human_review', pendingCount: 2, terminalCount: 4 }
    }))
    expect(result.status).toBe('blocked')
    expect(result.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['releaseApproval', 'releaseEvidence', 'shadowReviews']))
  })

  it('blocks mismatched commit binding', () => {
    const result = buildReleaseAuthorityReadiness(evidence({ signedPayload: { releaseCommit: 'b'.repeat(40) } }))
    expect(result.status).toBe('blocked')
    expect(result.blockers).toContainEqual({ name: 'releaseCommit', reason: 'all supplied evidence is bound to the exact release commit' })
  })

  it('rejects sensitive material and authority violations', () => {
    expect(() => buildReleaseAuthorityReadiness(evidence({ signedPayload: { signature: 'raw' } }))).toThrow('sensitive keys')
    expect(() => buildReleaseAuthorityReadiness(evidence({ releaseEvidence: { releaseEligible: true } }))).toThrow('authority or mutation violation')
  })

  it('fails closed when the CLI evidence files are not supplied', () => {
    const result = runCli({ RELEASE_AUTHORITY_TARGET: 'local_disposable' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false, authority: 'release_authority_readiness_evidence_only' })
  })

  it('verifies complete disposable redacted CLI evidence and emits source hashes without granting authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-authority-readiness-'))
    try {
      const files = writeEvidenceFiles(root, evidence())
      const result = runCli({
        RELEASE_AUTHORITY_TARGET: 'local_disposable',
        RELEASE_APPROVAL_FILE: files.releaseApproval,
        RELEASE_EVIDENCE_FILE: files.releaseEvidence,
        SHADOW_REVIEW_STATUS_FILE: files.shadowReviewStatus,
        CRYPTOGRAPHIC_SEQUENCE_FILE: files.cryptographicSequence,
        SIGNED_RELEASE_PAYLOAD_FILE: files.signedPayload,
        RELEASE_AUTHORITY_COMMIT: releaseCommit
      })
      const report = JSON.parse(result.stdout)
      expect(result.status).toBe(0)
      expect(report).toMatchObject({ status: 'ready_for_controlled_release_evaluation', target: 'local_disposable', readyForControlledEvaluation: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false })
      expect(Object.values(report.sourceHashes)).toHaveLength(5)
      expect(Object.values(report.sourceHashes).every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces protected-root path validation for authenticated target evidence', () => {
    const protectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-authority-protected-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-authority-outside-'))
    try {
      const files = writeEvidenceFiles(protectedRoot, evidence())
      const outsideFile = path.join(outsideRoot, 'release.json')
      fs.writeFileSync(outsideFile, JSON.stringify(evidence().releaseApproval), { mode: 0o600 })
      const result = runCli({
        RELEASE_AUTHORITY_TARGET: 'authenticated_target',
        PAYTRAY_PROTECTED_EVIDENCE_ROOT: protectedRoot,
        RELEASE_APPROVAL_FILE: outsideFile,
        RELEASE_EVIDENCE_FILE: files.releaseEvidence,
        SHADOW_REVIEW_STATUS_FILE: files.shadowReviewStatus,
        CRYPTOGRAPHIC_SEQUENCE_FILE: files.cryptographicSequence,
        SIGNED_RELEASE_PAYLOAD_FILE: files.signedPayload,
        RELEASE_AUTHORITY_COMMIT: releaseCommit
      })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(JSON.parse(result.stdout).reason).toContain('must be inside the protected evidence root')
    } finally {
      fs.rmSync(protectedRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})
