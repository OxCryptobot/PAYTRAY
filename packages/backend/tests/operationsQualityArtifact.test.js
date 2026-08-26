import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateOperationsQualityArtifact } from '../scripts/verify-operations-quality-artifact.mjs'

const backendDirectory = process.cwd()
const operationsQualityArtifactScriptPath = path.join(backendDirectory, 'scripts', 'verify-operations-quality-artifact.mjs')

function makeArtifact(overrides = {}) {
  return {
    reportKind: 'operations_quality',
    status: 'operator_blocked',
    strict: false,
    checkCount: 1,
    passedCount: 0,
    operatorBlockerCount: 1,
    unexpectedFailureCount: 0,
    checks: [{ name: 'fixture', state: 'operator_blocked', status: 'blocked', expectedBlocked: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }],
    operatorBlockers: [{ name: 'fixture', status: 'blocked', reason: 'disposable fixture' }],
    unexpectedFailures: [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    audit: {
      status: 'not_recorded',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    },
    ...overrides
  }
}

describe('operations-quality artifact verifier', () => {
  it('verifies a redacted no-database report while preserving safety fields', () => {
    const result = validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact()) })
    expect(result).toMatchObject({ status: 'verified', reportKind: 'operations_quality', audit: { status: 'not_recorded' }, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
  })

  it('rejects symlinked and non-regular artifact inputs in the CLI before parsing', async () => {
    const inputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-operations-quality-artifact-inputs-'))
    const artifactPath = path.join(inputDirectory, 'artifact.json')
    const symlinkPath = path.join(inputDirectory, 'artifact-link.json')
    const directoryPath = path.join(inputDirectory, 'artifact-directory')
    await fs.writeFile(artifactPath, JSON.stringify(makeArtifact()))
    await fs.symlink(artifactPath, symlinkPath)
    await fs.mkdir(directoryPath)
    try {
      for (const [inputPath, reason] of [[symlinkPath, `${symlinkPath} must not be a symlink`], [directoryPath, `${directoryPath} must be a regular file`]]) {
        let error
        try {
          execFileSync(process.execPath, [operationsQualityArtifactScriptPath, inputPath], {
            cwd: backendDirectory,
            encoding: 'utf8',
            env: { ...process.env, OPERATIONS_QUALITY_ARTIFACT_ISOLATED: 'true' }
          })
        } catch (caught) {
          error = caught
        }
        expect(error?.status).toBe(1)
        expect(JSON.parse(error?.stderr || error?.stdout)).toMatchObject({ reportKind: 'operations_quality', status: 'blocked', reason, authority: 'operations_quality_artifact_verification_only', mutation: 'read_only', releaseEligible: false, settlementAuthority: false, deploymentPerformed: false, settlementMutationPerformed: false })
      }
    } finally {
      await fs.rm(inputDirectory, { recursive: true, force: true })
    }
  })

  it('requires durable migration-018 audit persistence for recovery artifacts', () => {
    expect(() => validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact()), requireAudit: true })).toThrow('durable migration-018 audit persistence')
  })

  it('accepts a recorded audit only with exact run and report hash', () => {
    const result = validateOperationsQualityArtifact({
      content: JSON.stringify(makeArtifact({
        audit: {
          status: 'recorded',
          runId: '11111111-1111-4111-8111-111111111111',
          reportHash: 'a'.repeat(64),
          releaseEligible: false,
          settlementAuthority: false,
          mutation: 'read_only',
          deploymentPerformed: false,
          settlementMutationPerformed: false
        }
      })),
      requireAudit: true
    })
    expect(result.audit).toMatchObject({ status: 'recorded', runId: '11111111-1111-4111-8111-111111111111', reportHash: 'a'.repeat(64) })
  })

  it('rejects sensitive fields in captured JSON', () => {
    expect(() => validateOperationsQualityArtifact({ content: JSON.stringify(makeArtifact({ audit: { ...makeArtifact().audit, signature: 'forbidden' } })) })).toThrow('sensitive key')
  })
})
