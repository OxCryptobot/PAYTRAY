import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = path.resolve('scripts/submit-shadow-review-decisions.mjs')
const releaseCommit = 'e'.repeat(40)
const artifactSha256 = 'f'.repeat(64)
const runIds = [
  'd9280263-932b-45b0-a173-ed3e7e2dcb3c',
  '5d85ded6-4842-4091-85f3-8046e90c7b79',
  'eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49',
  '3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a',
  'c25b2bee-4fac-4f87-acf3-00541a093030',
  '7b0f934d-8bda-4b10-aa4c-d7fc019078e4'
]

function worksheet(overrides = {}) {
  return {
    releaseCommit,
    artifactSha256,
    reviews: runIds.map((runId) => ({
      runId,
      decision: 'rejected',
      notes: 'Human reviewer rationale is recorded outside the repository.',
      evidenceReviewed: 'Baseline, candidate, segments, rollback and limitations were reviewed.',
      rollbackTarget: 'baseline-v1'
    })),
    ...overrides
  }
}

function runCli(root, value, extraEnv = {}) {
  const file = path.join(root, 'worksheet.json')
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
  const env = {
    ...process.env,
    PAYTRAY_REVIEW_WORKSHEET_FILE: file,
    SHADOW_REVIEW_SUBMISSION_MODE: 'dry_run',
    ...extraEnv
  }
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd: path.resolve('.'), env, encoding: 'utf8' })
    return { status: 0, report: JSON.parse(stdout) }
  } catch (error) {
    const output = String(error.stdout || '')
    return { status: error.status, report: JSON.parse(output) }
  }
}

describe('shadow-review submission CLI contract', () => {
  it('validates exactly six reviews and carries the exact artifact hash in dry-run output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-shadow-cli-'))
    try {
      const result = runCli(root, worksheet())
      expect(result.status).toBe(0)
      expect(result.report).toMatchObject({ status: 'dry_run', releaseCommit, artifactSha256, expectedRunCount: 6, suppliedRunCount: 6, networkRequestsPerformed: false, submissionPerformed: false, applied: false, promotionStatus: 'shadow_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a missing or malformed artifact hash before any submission path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-shadow-cli-invalid-'))
    try {
      const missing = runCli(root, worksheet({ artifactSha256: undefined }))
      expect(missing.status).toBe(1)
      expect(missing.report).toMatchObject({ status: 'blocked', submissionPerformed: false, networkRequestsPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(missing.report.reason).toContain('artifactSha256')
      const malformed = runCli(root, worksheet({ artifactSha256: 'not-a-digest' }))
      expect(malformed.status).toBe(1)
      expect(malformed.report.reason).toContain('artifactSha256')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps submission guard binding strict for commit and artifact environment mismatches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-shadow-cli-binding-'))
    try {
      const submitGuardEnv = { SHADOW_REVIEW_SUBMISSION_MODE: 'submit', SHADOW_REVIEW_SUBMISSION_ENABLED: 'true', SHADOW_REVIEW_SUBMISSION_CONFIRMATION: 'I_UNDERSTAND_HUMAN_REVIEW_SUBMISSION', PAYTRAY_REVIEW_BASE_URL: 'http://127.0.0.1:1', PAYTRAY_REVIEW_ACCESS_TOKEN: 'a'.repeat(24), PAYTRAY_REVIEW_EXPECTED_ARTIFACT_SHA256: artifactSha256 }
      const commitMismatch = runCli(root, worksheet(), { ...submitGuardEnv, PAYTRAY_REVIEW_EXPECTED_COMMIT: 'a'.repeat(40) })
      expect(commitMismatch.status).toBe(1)
      expect(commitMismatch.report.reason).toContain('PAYTRAY_REVIEW_WORKSHEET_RELEASE_COMMIT')
      const artifactMismatch = runCli(root, worksheet(), { ...submitGuardEnv, PAYTRAY_REVIEW_EXPECTED_COMMIT: releaseCommit, PAYTRAY_REVIEW_EXPECTED_ARTIFACT_SHA256: 'b'.repeat(64) })
      expect(artifactMismatch.status).toBe(1)
      expect(artifactMismatch.report.reason).toContain('PAYTRAY_REVIEW_WORKSHEET_ARTIFACT_SHA256')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
