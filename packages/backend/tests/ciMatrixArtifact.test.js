import { describe, expect, it } from 'vitest'
import { validateCiMatrixArtifact } from '../scripts/verify-ci-matrix-artifact.mjs'

function blockerResolutionArtifact(overrides = {}) {
  return {
    reportKind: 'release_blocker_resolution',
    status: 'operator_blocked',
    trackingStatus: 'active',
    checkCount: 2,
    passedCount: 1,
    operatorBlockerCount: 1,
    unexpectedFailureCount: 0,
    resolvedByAutomatedGateCount: 1,
    dependencyGraphVersion: '2026-08-18.release-blockers.v1',
    nextAttemptableBlockers: ['railway-trial'],
    checks: [
      { name: 'quality-gate', gateState: 'passed', resolutionState: 'verified_by_release_gate', dependsOn: [], blockedBy: [], readyToAttempt: false },
      { name: 'railway-trial', gateState: 'operator_blocked', resolutionState: 'unassigned', dependsOn: [], blockedBy: [], readyToAttempt: true }
    ],
    operatorBlockers: [{ name: 'railway-trial', status: 'settings_unavailable', reason: 'operator evidence is required' }],
    unexpectedFailures: [],
    authority: 'release_blocker_resolution_tracking_only',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...overrides
  }
}

function artifact(overrides = {}) {
  return {
    reportKind: 'release_gates',
    status: 'operator_blocked',
    checkCount: 2,
    passedCount: 1,
    operatorBlockerCount: 1,
    unexpectedFailureCount: 0,
    checks: [{ name: 'quality-gate', state: 'passed' }, { name: 'railway-trial', state: 'operator_blocked' }],
    operatorBlockers: [{ name: 'railway-trial', status: 'settings_unavailable', reason: 'operator evidence is required' }],
    unexpectedFailures: [],
    authority: 'release_gate_inspection_only',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...overrides
  }
}

describe('CI matrix artifact verifier', () => {
  it('verifies a safe release-gate artifact', () => {
    expect(validateCiMatrixArtifact({ expectedReportKind: 'release_gates', content: JSON.stringify(artifact()) })).toMatchObject({
      status: 'verified',
      reportKind: 'release_gates',
      reportStatus: 'operator_blocked',
      checkCount: 2,
      operatorBlockerCount: 1,
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false
    })
  })

  it('verifies a blocker-resolution artifact with dependency metadata', () => {
    expect(validateCiMatrixArtifact({ expectedReportKind: 'release_blocker_resolution', content: JSON.stringify(blockerResolutionArtifact()) })).toMatchObject({
      status: 'verified',
      reportKind: 'release_blocker_resolution',
      reportStatus: 'operator_blocked',
      checkCount: 2,
      operatorBlockerCount: 1,
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false
    })
  })

  it('rejects malformed blocker-resolution dependency metadata and authority fields', () => {
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_blocker_resolution', content: JSON.stringify(blockerResolutionArtifact({ dependencyGraphVersion: '' })) })).toThrow('dependencyGraphVersion')
    const invalidDependencyArtifact = blockerResolutionArtifact({
      checks: [
        { ...blockerResolutionArtifact().checks[0], blockedBy: 'not-array' },
        blockerResolutionArtifact().checks[1]
      ]
    })
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_blocker_resolution', content: JSON.stringify(invalidDependencyArtifact) })).toThrow('dependency arrays')
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_blocker_resolution', content: JSON.stringify(blockerResolutionArtifact({ releaseEligible: true })) })).toThrow('releaseEligible')
  })

  it('verifies an operations-quality artifact with the expected provenance', () => {
    expect(validateCiMatrixArtifact({
      expectedReportKind: 'operations_quality',
      content: JSON.stringify(artifact({ reportKind: 'operations_quality', authority: 'operations_quality_only' }))
    })).toMatchObject({ status: 'verified', reportKind: 'operations_quality', authority: 'operations_quality_only' })
  })

  it('rejects count drift and immutable safety-field changes', () => {
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_gates', content: JSON.stringify(artifact({ checkCount: 3 })) })).toThrow('checkCount')
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_gates', content: JSON.stringify(artifact({ releaseEligible: true })) })).toThrow('releaseEligible')
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_gates', content: JSON.stringify(artifact({ mutation: 'write' })) })).toThrow('mutation')
  })

  it('requires named release checks when requested by CI', () => {
    const artifactWithCustody = artifact({
      checkCount: 3,
      operatorBlockerCount: 2,
      checks: [
        { name: 'quality-gate', state: 'passed' },
        { name: 'railway-trial', state: 'operator_blocked' },
        { name: 'secret-manager-custody', state: 'operator_blocked' }
      ],
      operatorBlockers: [
        { name: 'railway-trial', status: 'settings_unavailable', reason: 'operator evidence is required' },
        { name: 'secret-manager-custody', status: 'blocked', reason: 'operator evidence is required' }
      ]
    })
    expect(validateCiMatrixArtifact({
      expectedReportKind: 'release_gates',
      requiredCheckNames: ['secret-manager-custody'],
      content: JSON.stringify(artifactWithCustody)
    })).toMatchObject({ status: 'verified', checkCount: 3, operatorBlockerCount: 2 })
    expect(() => validateCiMatrixArtifact({
      expectedReportKind: 'release_gates',
      requiredCheckNames: ['secret-manager-custody'],
      content: JSON.stringify(artifact())
    })).toThrow('missing required check')
  })

  it('rejects wrong report provenance and recursive sensitive fields', () => {
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'operations_quality', content: JSON.stringify(artifact()) })).toThrow('reportKind')
    expect(() => validateCiMatrixArtifact({ expectedReportKind: 'release_gates', content: JSON.stringify(artifact({ checks: [{ name: 'release-gates', metadata: { signingSecret: 'never' } }, { name: 'quality-gate', state: 'passed' }] })) })).toThrow('sensitive key')
  })
})
