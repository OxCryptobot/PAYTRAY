import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const verifierPath = path.join(backendDirectory, 'scripts', 'verify-migration-coverage.mjs')

describe('migration coverage guard', () => {
  it('requires every present migration 001-020 to have verifier, package, CI, and recovery coverage', () => {
    const output = execFileSync(process.execPath, [verifierPath], {
      cwd: backendDirectory,
      env: { ...process.env, MIGRATION_COVERAGE_AUDIT_ISOLATED: 'true' },
      encoding: 'utf8'
    })
    const report = JSON.parse(output)
    expect(report.status).toBe('verified')
    expect(report.migrationCount).toBe(20)
    expect(report.futureBoundary).toEqual({ '021': 'not_present', '022': 'not_present' })
    expect(report.authority).toBe('coverage_audit_only')
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
    expect(report.mutation).toBe('read_only')
  })

  it('keeps migration-021/022 explicitly not-present and rejects fabricated CI or recovery references', async () => {
    const source = await fs.readFile(verifierPath, 'utf8')
    expect(source).toContain("migrationFiles.map((name) => name.slice(0, 3)), [...EXPECTED.keys()]")
    expect(source).toMatch(/assert\.doesNotMatch\(workflow, \/migration-021\|migration-022\|restored-migration-021\|restored-migration-022\/i/)
    expect(source).toMatch(/assert\.doesNotMatch\(recoveryVerifier, \/migration-021\|migration-022\|restored-migration-021\|restored-migration-022\/i/)
    expect(source).toContain("futureBoundary: { '021': 'not_present', '022': 'not_present' }")
    expect(source).toContain("authority: 'coverage_audit_only'")
    expect(source).toContain("releaseEligible: false")
    expect(source).toContain("settlementAuthority: false")
    expect(source).toContain("mutation: 'read_only'")
  })
})
