import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const repositoryRoot = path.resolve(backendDirectory, '..', '..')
const verifierPath = path.join(backendDirectory, 'scripts', 'verify-migration-coverage.mjs')

function safetyAssertions(report) {
  expect(report.authority).toBe('coverage_audit_only')
  expect(report.releaseEligible).toBe(false)
  expect(report.settlementAuthority).toBe(false)
  expect(report.mutation).toBe('read_only')
  expect(report.deploymentPerformed).toBe(false)
  expect(report.settlementMutationPerformed).toBe(false)
}

async function copyCoverageFixture(directory) {
  const fakeRepository = path.join(directory, 'repo')
  await fs.mkdir(path.join(fakeRepository, 'packages/backend'), { recursive: true })
  await fs.mkdir(path.join(fakeRepository, '.github/workflows'), { recursive: true })
  await fs.cp(path.join(repositoryRoot, 'packages/backend/migrations'), path.join(fakeRepository, 'packages/backend/migrations'), { recursive: true })
  await fs.cp(path.join(repositoryRoot, 'packages/backend/scripts'), path.join(fakeRepository, 'packages/backend/scripts'), { recursive: true })
  await fs.cp(path.join(repositoryRoot, 'package.json'), path.join(fakeRepository, 'package.json'))
  await fs.cp(path.join(repositoryRoot, '.github/workflows/paytray-quality.yml'), path.join(fakeRepository, '.github/workflows/paytray-quality.yml'))
  return fakeRepository
}

function runCoverageVerifier(fakeRepository) {
  return execFileSync(process.execPath, [path.join(fakeRepository, 'packages/backend/scripts/verify-migration-coverage.mjs')], {
    cwd: path.join(fakeRepository, 'packages/backend'),
    env: { ...process.env, MIGRATION_COVERAGE_AUDIT_ISOLATED: 'true' },
    encoding: 'utf8'
  })
}

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
    safetyAssertions(report)
  })

  it.each([
    ['CI workflow', '.github/workflows/paytray-quality.yml', 'migration-021'],
    ['recovery verifier', 'packages/backend/scripts/verify-recovery-artifact.mjs', 'migration-022']
  ])('fails closed when a fabricated reference is added to the %s', async (_label, relativePath, fabricatedReference) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-migration-boundary-'))
    try {
      const fakeRepository = await copyCoverageFixture(directory)
      const targetPath = path.join(fakeRepository, relativePath)
      const source = await fs.readFile(targetPath, 'utf8')
      await fs.writeFile(targetPath, `${source}\n${fabricatedReference}\n`)

      let failure
      try {
        runCoverageVerifier(fakeRepository)
      } catch (error) {
        failure = error
      }

      expect(failure).toBeTruthy()
      const report = JSON.parse(String(failure.stderr))
      expect(report.status).toBe('blocked')
      expect(report.reason).toMatch(/must not fabricate migration-021\/022 coverage|must not fabricate migration-021\/022 coverage/i)
      safetyAssertions(report)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
