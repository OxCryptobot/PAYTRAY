import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseBlockerClearancePlan } from '../scripts/verify-release-blocker-clearance-plan.mjs'

const script = path.resolve(process.cwd(), 'scripts/verify-release-blocker-clearance-plan.mjs')

function makeReport(operatorBlockers = []) {
  return {
    reportKind: 'release_gates',
    status: operatorBlockers.length ? 'operator_blocked' : 'passed',
    checkCount: operatorBlockers.length,
    checks: operatorBlockers.map((blocker) => ({ name: blocker.name, state: 'operator_blocked' })),
    operatorBlockers,
    unexpectedFailures: [],
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only'
  }
}

describe('release blocker clearance plan', () => {
  it('normalizes every blocker and preserves read-only authority boundaries', () => {
    const report = makeReport([
      { name: 'verifier-cursor-evidence', status: 'operator_blocked', reason: 'cursor is missing', clearanceCriteria: 'fresh Base Sepolia cursor' },
      { name: 'railway-trial', status: 'settings_unavailable', reason: 'settings unavailable', clearanceCriteria: 'authenticated redacted settings' }
    ])
    const result = buildReleaseBlockerClearancePlan({ report, sourceSha256: 'a'.repeat(64) })
    expect(result).toMatchObject({ status: 'operator_blocked', planStatus: 'complete', target: 'local_disposable', blockerCount: 2, criteriaComplete: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers.map((blocker) => blocker.order)).toEqual([1, 2])
  })

  it('fails closed when a blocker lacks clearance criteria', () => {
    const report = makeReport([{ name: 'recovery', status: 'blocked', reason: 'missing backup' }])
    expect(() => buildReleaseBlockerClearancePlan({ report })).toThrow('requires clearanceCriteria')
  })

  it('rejects sensitive evidence fields', () => {
    const report = makeReport([{ name: 'operator-key-custody', status: 'blocked', reason: 'missing evidence', clearanceCriteria: 'custody evidence', privateKey: 'must never appear' }])
    expect(() => buildReleaseBlockerClearancePlan({ report })).toThrow('sensitive key is not allowed')
  })

  it('rejects authority violations and reports an empty plan as non-authoritative ready metadata', () => {
    const unsafe = { ...makeReport([]), releaseEligible: true }
    expect(() => buildReleaseBlockerClearancePlan({ report: unsafe })).toThrow('immutable authority violation')
    const result = buildReleaseBlockerClearancePlan({ report: makeReport([]), target: 'authenticated_target' })
    expect(result).toMatchObject({ status: 'ready', planStatus: 'complete', blockerCount: 0, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
  })

  it('rejects symlinked and non-regular CLI release-gates inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-clearance-inputs-'))
    try {
      const reportPath = path.join(root, 'release-gates.json')
      const linkPath = path.join(root, 'release-gates-link.json')
      const directoryPath = path.join(root, 'release-gates-directory')
      fs.writeFileSync(reportPath, JSON.stringify(makeReport([{ name: 'migrations', status: 'operator_blocked', reason: 'database unavailable', clearanceCriteria: 'ready target database' }])), { mode: 0o600 })
      fs.symlinkSync(reportPath, linkPath)
      fs.mkdirSync(directoryPath)

      const invoke = (filePath) => {
        const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), env: { ...process.env, BLOCKER_CLEARANCE_RELEASE_GATES_FILE: filePath }, encoding: 'utf8' })
        return { status: result.status, output: JSON.parse(result.stdout) }
      }

      const symlinkResult = invoke(linkPath)
      expect(symlinkResult.status).toBe(1)
      expect(symlinkResult.output).toMatchObject({ status: 'blocked', planStatus: 'incomplete', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, authority: 'release_blocker_clearance_plan_only' })
      expect(symlinkResult.output.reason).toContain('must not be a symlink')

      const directoryResult = invoke(directoryPath)
      expect(directoryResult.status).toBe(1)
      expect(directoryResult.output).toMatchObject({ status: 'blocked', planStatus: 'incomplete', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(directoryResult.output.reason).toContain('must be a regular file')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
