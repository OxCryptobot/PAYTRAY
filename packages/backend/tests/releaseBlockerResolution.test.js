import { describe, expect, it } from 'vitest'
import { buildReleaseBlockerResolution } from '../scripts/verify-release-blocker-resolution.mjs'

const releaseCommit = 'a'.repeat(40)

function makeReport(checks = []) {
  return {
    reportKind: 'release_gates',
    status: checks.some((check) => check.state !== 'passed') ? 'operator_blocked' : 'passed',
    checks,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

function check(name, state = 'operator_blocked', overrides = {}) {
  return { name, state, reason: state === 'passed' ? 'check passed' : 'operator evidence is required', clearanceCriteria: 'independently captured evidence', mutation: 'read_only', releaseEligible: false, settlementAuthority: false, ...overrides }
}

describe('release blocker resolution tracking', () => {
  it('tracks open blockers and automated gate resolutions without granting authority', () => {
    const report = buildReleaseBlockerResolution({
      report: makeReport([check('quality-gate', 'passed'), check('railway-trial')]),
      sourceSha256: 'a'.repeat(64),
      releaseCommit,
      tracking: {
        reportKind: 'release_blocker_resolution_tracking',
        releaseCommit,
        entries: [{ name: 'railway-trial', status: 'operator_in_progress', lastCheckedAt: '2026-08-18T00:00:00.000Z' }],
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only'
      }
    })
    expect(report).toMatchObject({ status: 'operator_blocked', trackingStatus: 'active', checkCount: 2, resolvedByAutomatedGateCount: 1, openBlockerCount: 1, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false })
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'quality-gate', resolutionState: 'verified_by_release_gate', automatedCheck: true, requiresOperatorEvidence: false }),
      expect.objectContaining({ name: 'railway-trial', resolutionState: 'operator_in_progress', automatedCheck: false, requiresOperatorEvidence: true })
    ]))
  })

  it('does not treat tracking metadata as evidence that clears a gate', () => {
    const report = buildReleaseBlockerResolution({
      report: makeReport([check('release-authority-readiness')]),
      releaseCommit,
      tracking: {
        reportKind: 'release_blocker_resolution_tracking',
        releaseCommit,
        entries: [{ name: 'release-authority-readiness', status: 'evidence_submitted', evidenceArtifactSha256: 'b'.repeat(64) }],
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only'
      }
    })
    expect(report).toMatchObject({ status: 'operator_blocked', openBlockerCount: 1, releaseEligible: false, settlementAuthority: false })
    expect(report.checks[0]).toMatchObject({ gateState: 'operator_blocked', resolutionState: 'evidence_submitted', automatedCheck: false, requiresOperatorEvidence: true })
  })

  it('rejects mismatched commits and orphan tracking entries', () => {
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed')]), releaseCommit: 'b'.repeat(40), tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [] } })).toThrow()
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed')]), releaseCommit, tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [{ name: 'not-a-gate', status: 'unassigned' }] } })).toThrow('do not match release-gates checks')
  })

  it('rejects sensitive fields and authority violations', () => {
    expect(() => buildReleaseBlockerResolution({ report: { ...makeReport([check('quality-gate', 'passed')]), privateKey: 'never' }, releaseCommit })).toThrow('sensitive key is not allowed')
    expect(() => buildReleaseBlockerResolution({ report: { ...makeReport([check('quality-gate', 'passed')]), releaseEligible: true }, releaseCommit })).toThrow('immutable authority violation')
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed')]), releaseCommit, tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [], settlementAuthority: true } })).toThrow('immutable authority violation')
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed', { releaseEligible: true })]), releaseCommit })).toThrow('immutable authority violation')
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed', { mutation: 'write' })]), releaseCommit })).toThrow('unsafe mutation value')
  })

  it('marks unexpected engineering failures separately and rejects duplicate release-gate checks', () => {
    const report = buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'failed')]), releaseCommit })
    expect(report).toMatchObject({ status: 'failed', trackingStatus: 'active', openBlockerCount: 1, unexpectedFailureCount: 1 })
    expect(report.checks[0]).toMatchObject({ requiresEngineeringFix: true, requiresOperatorEvidence: false })
    expect(() => buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed'), check('quality-gate', 'passed')]), releaseCommit })).toThrow('duplicate release-gate check')
  })

  it('returns a non-authoritative complete status only when every release-gate check passed', () => {
    const report = buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed'), check('release-manifest', 'passed')]), releaseCommit })
    expect(report).toMatchObject({ status: 'ready', trackingStatus: 'complete', resolvedByAutomatedGateCount: 2, openBlockerCount: 0, unexpectedFailureCount: 0, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
  })
})
