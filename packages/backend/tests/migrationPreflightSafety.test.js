import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()

const verifiers = [
  ['013', 'verify-migration-013-verifier-cursors.mjs', 'MIGRATION_013_CONTRACT_ISOLATED', 'MIGRATION_013_CONTRACT_ISOLATED=true is required'],
  ['014', 'verify-migration-014-webhook-replay-claims.mjs', 'MIGRATION_014_CONTRACT_ISOLATED', 'MIGRATION_014_CONTRACT_ISOLATED=true is required'],
  ['015', 'verify-migration-015-trust-signals.mjs', 'MIGRATION_015_CONTRACT_ISOLATED', 'MIGRATION_015_CONTRACT_ISOLATED=true is required'],
  ['016', 'verify-migration-016-webhook-inbox.mjs', 'MIGRATION_016_CONTRACT_ISOLATED', 'MIGRATION_016_CONTRACT_ISOLATED=true is required'],
  ['017', 'verify-migration-017-extension-hooks.mjs', 'MIGRATION_017_CONTRACT_ISOLATED', 'MIGRATION_017_CONTRACT_ISOLATED=true is required'],
  ['018', 'verify-migration-018-concurrency.mjs', 'MIGRATION_018_CONCURRENCY_ISOLATED', 'MIGRATION_018_CONCURRENCY_ISOLATED=true is required'],
  ['019', 'verify-migration-019-constraints.mjs', 'MIGRATION_019_CONTRACT_ISOLATED', 'MIGRATION_019_CONTRACT_ISOLATED=true is required'],
  ['020', 'verify-migration-020-outbox-leases.mjs', 'MIGRATION_020_CONTRACT_ISOLATED', 'MIGRATION_020_CONTRACT_ISOLATED=true is required']
]

function assertBlockedSafety(report) {
  expect(report.status).toBe('blocked')
  expect(report.releaseEligible).toBe(false)
  expect(report.settlementAuthority).toBe(false)
  expect(report.mutation).toBe('read_only')
  expect(report.deploymentPerformed).toBe(false)
  expect(report.settlementMutationPerformed).toBe(false)
}

describe('migration-013–020 verifier preflight safety', () => {
  it.each(verifiers)('returns a structured fail-closed report for migration-%s when isolation is absent', (_migration, filename, isolationVariable, expectedReason) => {
    const verifierPath = path.join(backendDirectory, 'scripts', filename)
    let failure
    try {
      execFileSync(process.execPath, [verifierPath], {
        cwd: backendDirectory,
        env: { ...process.env, [isolationVariable]: 'false', DATABASE_URL: '' },
        encoding: 'utf8'
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeTruthy()
    expect(failure.status).toBe(1)
    const report = JSON.parse(String(failure.stderr))
    expect(report.reason).toBe(expectedReason)
    assertBlockedSafety(report)
  })
})
