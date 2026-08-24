import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

  it('ingests a verified redacted evidence reference and preserves the open gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-blocker-reference-'))
    try {
      const referenceReport = { reportKind: 'release_evidence', status: 'verified', releaseCommit, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }
      const referencePath = path.join(root, 'release-evidence.json')
      const raw = JSON.stringify(referenceReport)
      fs.writeFileSync(referencePath, raw, { mode: 0o600 })
      const sha256 = createHash('sha256').update(raw).digest('hex')
      const report = buildReleaseBlockerResolution({
        report: makeReport([check('release-evidence')]),
        releaseCommit,
        tracking: {
          reportKind: 'release_blocker_resolution_tracking',
          releaseCommit,
          entries: [{
            name: 'release-evidence',
            status: 'evidence_submitted',
            evidenceReference: {
              kind: 'release_evidence',
              target: 'local_disposable',
              path: referencePath,
              sha256,
              reportKind: 'release_evidence',
              releaseCommit,
              verificationStatus: 'independently_verified'
            }
          }],
          releaseEligible: false,
          settlementAuthority: false,
          mutation: 'read_only'
        }
      })
      expect(report).toMatchObject({ status: 'operator_blocked', openBlockerCount: 1, releaseEligible: false, settlementAuthority: false })
      expect(report.checks[0]).toMatchObject({ resolutionState: 'evidence_submitted', referenceState: 'independently_verified_reference', evidenceArtifactSha256: sha256, automatedCheck: false })
      expect(report.checks[0].evidenceReference).toMatchObject({ kind: 'release_evidence', reportKind: 'release_evidence', releaseCommit, verificationStatus: 'independently_verified' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects mismatched, sensitive, or protected-root-escaping evidence references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-blocker-reference-safe-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-blocker-reference-outside-'))
    try {
      const referenceReport = { reportKind: 'release_evidence', status: 'verified', releaseCommit, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }
      const referencePath = path.join(root, 'release-evidence.json')
      const raw = JSON.stringify(referenceReport)
      fs.writeFileSync(referencePath, raw, { mode: 0o600 })
      const sha256 = createHash('sha256').update(raw).digest('hex')
      const baseReference = { kind: 'release_evidence', target: 'local_disposable', path: referencePath, sha256, reportKind: 'release_evidence', releaseCommit, verificationStatus: 'independently_verified' }
      expect(() => buildReleaseBlockerResolution({ report: makeReport([check('release-evidence')]), releaseCommit, tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [{ name: 'release-evidence', evidenceReference: { ...baseReference, sha256: 'a'.repeat(64) } }] } })).toThrow('sha256 does not match')

      const sensitivePath = path.join(root, 'sensitive.json')
      const sensitiveRaw = JSON.stringify({ ...referenceReport, rawSignature: 'must-not-be-ingested' })
      fs.writeFileSync(sensitivePath, sensitiveRaw, { mode: 0o600 })
      const sensitiveSha256 = createHash('sha256').update(sensitiveRaw).digest('hex')
      expect(() => buildReleaseBlockerResolution({ report: makeReport([check('release-evidence')]), releaseCommit, tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [{ name: 'release-evidence', evidenceReference: { ...baseReference, path: sensitivePath, sha256: sensitiveSha256 } }] } })).toThrow('sensitive key is not allowed')

      const outsidePath = path.join(outsideRoot, 'outside.json')
      fs.writeFileSync(outsidePath, raw, { mode: 0o600 })
      const outsideReference = { ...baseReference, target: 'authenticated_target', path: outsidePath }
      expect(() => buildReleaseBlockerResolution({ report: makeReport([check('release-evidence')]), releaseCommit, tracking: { reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [{ name: 'release-evidence', evidenceReference: outsideReference }] } })).toThrow('must be inside the protected evidence root')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
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

  it('accepts an independently verified advisory-AI reference without clearing the gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-reference-'))
    try {
      const referenceReport = { reportKind: 'advisory_ai_evidence', status: 'ready', releaseCommit, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false, promotionStatus: 'shadow_only', humanOverrideRequired: true, rawContentPersisted: false }
      const referencePath = path.join(root, 'advisory-ai.json')
      const raw = JSON.stringify(referenceReport)
      fs.writeFileSync(referencePath, raw, { mode: 0o600 })
      const sha256 = createHash('sha256').update(raw).digest('hex')
      const report = buildReleaseBlockerResolution({
        report: makeReport([check('advisory-ai'), check('release-evidence')]),
        releaseCommit,
        tracking: {
          reportKind: 'release_blocker_resolution_tracking',
          releaseCommit,
          entries: [{ name: 'advisory-ai', status: 'evidence_submitted', evidenceReference: { kind: 'advisory_ai', target: 'local_disposable', path: referencePath, sha256, reportKind: 'advisory_ai_evidence', releaseCommit, verificationStatus: 'independently_verified' } }]
        }
      })
      expect(report.checks.find((item) => item.name === 'advisory-ai')).toMatchObject({ referenceState: 'independently_verified_reference', resolutionState: 'evidence_submitted', automatedCheck: false })
      expect(report.checks.find((item) => item.name === 'release-evidence')).toMatchObject({ blockedBy: expect.arrayContaining(['advisory-ai']), readyToAttempt: false })
      expect(report).toMatchObject({ releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('computes the next actionable blocker set without changing gate state', () => {
    const report = buildReleaseBlockerResolution({
      report: makeReport([
        check('migrations'),
        check('railway-trial'),
        check('verifier-operations'),
        check('advisory-ai')
      ]),
      releaseCommit
    })
    expect(report.nextAttemptableBlockers).toEqual(['migrations', 'railway-trial', 'advisory-ai'])
    expect(report.checks.find((item) => item.name === 'verifier-operations')).toMatchObject({ blockedBy: ['migrations', 'railway-trial'], readyToAttempt: false, nextAction: 'resolve dependencies first: migrations, railway-trial' })
    expect(report).toMatchObject({ status: 'operator_blocked', openBlockerCount: 4, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
  })

  it('returns a non-authoritative complete status only when every release-gate check passed', () => {
    const report = buildReleaseBlockerResolution({ report: makeReport([check('quality-gate', 'passed'), check('release-manifest', 'passed')]), releaseCommit })
    expect(report).toMatchObject({ status: 'ready', trackingStatus: 'complete', resolvedByAutomatedGateCount: 2, openBlockerCount: 0, unexpectedFailureCount: 0, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
  })

  it('rejects symlinked top-level release-gate and tracking inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-blocker-inputs-'))
    try {
      const releaseGatesPath = path.join(root, 'release-gates.json')
      const trackingPath = path.join(root, 'tracking.json')
      const releaseGatesLink = path.join(root, 'release-gates-link.json')
      const trackingLink = path.join(root, 'tracking-link.json')
      const releaseGatesRaw = JSON.stringify(makeReport([check('quality-gate', 'passed')]))
      const trackingRaw = JSON.stringify({ reportKind: 'release_blocker_resolution_tracking', releaseCommit, entries: [], releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      fs.writeFileSync(releaseGatesPath, releaseGatesRaw, { mode: 0o600 })
      fs.writeFileSync(trackingPath, trackingRaw, { mode: 0o600 })
      fs.symlinkSync(releaseGatesPath, releaseGatesLink)
      fs.symlinkSync(trackingPath, trackingLink)

      const invoke = (env) => {
        const result = spawnSync(process.execPath, [path.resolve(process.cwd(), 'scripts/verify-release-blocker-resolution.mjs')], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' })
        return { status: result.status, output: JSON.parse(result.stdout) }
      }

      const gateResult = invoke({ BLOCKER_RESOLUTION_RELEASE_GATES_FILE: releaseGatesLink, BLOCKER_RESOLUTION_COMMIT: releaseCommit })
      expect(gateResult.status).toBe(1)
      expect(gateResult.output).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
      expect(gateResult.output.reason).toContain('must be a regular non-symlink file')

      const trackingResult = invoke({ BLOCKER_RESOLUTION_RELEASE_GATES_FILE: releaseGatesPath, BLOCKER_RESOLUTION_TRACKING_FILE: trackingLink, BLOCKER_RESOLUTION_COMMIT: releaseCommit })
      expect(trackingResult.status).toBe(1)
      expect(trackingResult.output).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
      expect(trackingResult.output.reason).toContain('must be a regular non-symlink file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
