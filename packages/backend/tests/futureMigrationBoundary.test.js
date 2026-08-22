import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryPath = path.resolve(process.cwd(), '..', '..')
const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-future-migration-boundary.mjs')
const boundaryOwner = "futureBoundary: { '021': 'not_present', '022': 'not_present' }"

async function createFixture(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-future-boundary-'))
  await fs.mkdir(path.join(directory, 'packages/backend/migrations'), { recursive: true })
  await fs.mkdir(path.join(directory, 'packages/backend/scripts'), { recursive: true })
  await fs.mkdir(path.join(directory, '.github/workflows'), { recursive: true })
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(overrides.packageJson ?? {}))
  await fs.writeFile(path.join(directory, '.github/workflows/paytray-quality.yml'), overrides.workflow ?? '')
  await fs.writeFile(path.join(directory, 'packages/backend/scripts/verify-recovery-artifact.mjs'), overrides.recoveryVerifier ?? '')
  await fs.writeFile(path.join(directory, 'packages/backend/scripts/verify-postgres-assertion-traceability.mjs'), overrides.sourceTraceability ?? '')
  await fs.writeFile(path.join(directory, 'packages/backend/scripts/verify-migration-coverage.mjs'), overrides.coverageOwner ?? boundaryOwner)
  if (overrides.sqlFile) await fs.writeFile(path.join(directory, 'packages/backend/migrations', overrides.sqlFile), '')
  if (overrides.verifierFile) await fs.writeFile(path.join(directory, 'packages/backend/scripts', overrides.verifierFile), '')
  return directory
}

function runAudit(targetRepository, outputPath) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, outputPath], {
      cwd: backendDirectory,
      env: { ...process.env, PAYTRAY_REPOSITORY_PATH: targetRepository, MIGRATION_FUTURE_BOUNDARY_OUTPUT_PATH: outputPath },
      encoding: 'utf8'
    })
    return { report: JSON.parse(stdout), status: 0 }
  } catch (error) {
    return { report: JSON.parse(String(error.stderr)), status: error.status }
  }
}

describe('migration-021/022 future boundary contract', () => {
  it('verifies the real repository remains explicitly not_present for 021 and 022', async () => {
    const outputPath = path.join(os.tmpdir(), `paytray-future-boundary-${process.pid}.json`)
    const result = runAudit(repositoryPath, outputPath)
    expect(result.status).toBe(0)
    expect(result.report.status).toBe('verified')
    expect(result.report.boundary).toEqual({ '021': 'not_present', '022': 'not_present' })
    const packageJson = JSON.parse(await fs.readFile(path.join(repositoryPath, 'package.json'), 'utf8'))
    const workflow = await fs.readFile(path.join(repositoryPath, '.github/workflows/paytray-quality.yml'), 'utf8')
    expect(packageJson.scripts['backend:release:migrations:future-boundary:check']).toBe('node packages/backend/scripts/verify-future-migration-boundary.mjs')
    expect(workflow).toContain('Verify future migration absence boundary')
    expect(result.report.checks['021'].sqlStatus).toBe('not_present')
    expect(result.report.checks['021'].verifierStatus).toBe('not_present')
    expect(result.report.checks['022'].sqlStatus).toBe('not_present')
    expect(result.report.checks['022'].verifierStatus).toBe('not_present')
    expect(Object.values(result.report.authorityChecks).every(Boolean)).toBe(true)
    expect(result.report.releaseEligible).toBe(false)
    expect(result.report.settlementAuthority).toBe(false)
    expect(result.report.mutation).toBe('read_only')
    expect(result.report.deploymentPerformed).toBe(false)
    expect(result.report.settlementMutationPerformed).toBe(false)
    return fs.rm(outputPath, { force: true })
  })

  it.each([
    ['021 SQL source', { sqlFile: '021_future.sql' }, '021'],
    ['022 verifier source', { verifierFile: 'verify-migration-022-future.mjs' }, '022'],
    ['021 package script', { packageJson: { scripts: { 'backend:release:migration:021:check': 'node future.mjs' } } }, 'packageScripts'],
    ['022 workflow reference', { workflow: 'Run migration-022 future contract' }, 'workflowReferences'],
    ['021 recovery reference', { recoveryVerifier: 'restored-migration-021.json' }, 'recoveryAllowlist'],
    ['022 source-traceability reference', { sourceTraceability: 'migration-022' }, 'sourceTraceability'],
    ['missing boundary owner', { coverageOwner: '' }, 'coverageOwner']
  ])('blocks fabricated %s evidence', async (_label, overrides, expectedBoundary) => {
    const directory = await createFixture(overrides)
    const outputPath = path.join(directory, 'boundary.json')
    try {
      const result = runAudit(directory, outputPath)
      expect(result.status).toBe(1)
      expect(result.report.status).toBe('blocked')
      expect(result.report.errors.some((error) => error.boundary === expectedBoundary)).toBe(true)
      expect(result.report.releaseEligible).toBe(false)
      expect(result.report.settlementAuthority).toBe(false)
      expect(result.report.mutation).toBe('read_only')
      expect(result.report.deploymentPerformed).toBe(false)
      expect(result.report.settlementMutationPerformed).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
