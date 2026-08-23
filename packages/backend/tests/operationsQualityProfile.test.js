import { describe, expect, it } from 'vitest'
import { validateOperationsQualityProfile } from '../scripts/verify-operations-quality-profile.mjs'

const expectedNames = [
  'quality-gate',
  'migrations',
  'extension-contract',
  'sdk-contract',
  'verifier-worker-config',
  'target-operations',
  'release-evidence',
  'reconciliation-evidence',
  'evidence-bundle',
  'release-gates',
  'secret-manager-custody'
]
const expectedScripts = [
  'backend:quality:check',
  'backend:migrations:check',
  'backend:extension:contract:check',
  'backend:sdk:contract:check',
  'backend:verifier:worker:check',
  'backend:target:operations:check',
  'backend:release:evidence:check',
  'backend:reconciliation:evidence:check',
  'backend:ops:evidence:bundle:check',
  'backend:release:gates:check',
  'backend:release:key:secret-manager:check'
]

function makeProfile(overrides = {}) {
  const checks = expectedNames.map((name, index) => ({
    index,
    name,
    script: expectedScripts[index],
    state: index === 0 ? 'passed' : 'operator_blocked',
    exitCode: index === 0 ? 0 : 1,
    status: index === 0 ? 'passed' : 'blocked',
    expectedBlocked: index !== 0,
    reason: index === 0 ? 'check passed' : 'operator evidence is required',
    clearanceCriteria: null,
    authority: null,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: null,
    elapsedMs: index + 1,
    startedAt: '2026-08-23T00:00:00.000Z',
    timingBasis: 'ci_step_diagnostic'
  }))
  return {
    status: 'operator_blocked',
    reportKind: 'operations_quality_profile',
    strict: false,
    profileConcurrency: 4,
    parallelSafeChecks: ['extension-contract', 'sdk-contract', 'verifier-worker-config'],
    serialChecks: ['quality-gate', 'migrations', 'target-operations', 'release-evidence', 'reconciliation-evidence', 'evidence-bundle', 'release-gates', 'secret-manager-custody'],
    timingBasis: 'ci_step_diagnostic',
    authority: 'operations_quality_profile_diagnostic_only',
    checkCount: 11,
    passedCount: 1,
    operatorBlockerCount: 10,
    unexpectedFailureCount: 0,
    checks,
    operatorBlockers: checks.slice(1).map(({ name, status, reason }) => ({ name, status, reason })),
    unexpectedFailures: [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    generatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides
  }
}

describe('operations-quality profile artifact verifier', () => {
  it('accepts the canonical eleven-check diagnostic report', () => {
    expect(validateOperationsQualityProfile({ content: JSON.stringify(makeProfile()) })).toMatchObject({
      status: 'verified',
      reportKind: 'operations_quality_profile',
      reportStatus: 'operator_blocked',
      checkCount: 11,
      operatorBlockerCount: 10,
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false
    })
  })

  it('rejects check order or script binding drift', () => {
    const profile = makeProfile()
    profile.checks[2].script = 'backend:unexpected:check'
    expect(() => validateOperationsQualityProfile({ content: JSON.stringify(profile) })).toThrow('script binding')
  })

  it('rejects elapsed-time and count reconciliation drift', () => {
    const profile = makeProfile({ operatorBlockerCount: 9 })
    profile.checks[4].elapsedMs = -1
    expect(() => validateOperationsQualityProfile({ content: JSON.stringify(profile) })).toThrow('elapsedMs')
    profile.checks[4].elapsedMs = 5
    expect(() => validateOperationsQualityProfile({ content: JSON.stringify(profile) })).toThrow('counts do not reconcile')
  })

  it('rejects sensitive fields and authority-positive values', () => {
    const sensitive = makeProfile({ operatorBlockers: [{ name: 'x', reviewerNotes: 'forbidden' }] })
    expect(() => validateOperationsQualityProfile({ content: JSON.stringify(sensitive) })).toThrow('sensitive key')
    const unsafe = makeProfile({ releaseEligible: true })
    expect(() => validateOperationsQualityProfile({ content: JSON.stringify(unsafe) })).toThrow('releaseEligible')
  })
})
