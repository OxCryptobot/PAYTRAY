import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-release-attestation-artifacts.mjs')
const repositoryDirectory = path.resolve(backendDirectory, '../..')
const authorities = {
  'migration-source-traceability.json': 'assertion_traceability_audit_only',
  'migration-race-boundaries.json': 'race_boundary_audit_only',
  'migration-runtime-races.json': 'runtime_race_traceability_audit_only',
  'migration-future-boundary.json': 'future_migration_boundary_audit_only',
  'downstream-integration-boundary.json': 'downstream_integration_boundary_audit_only'
}
const safety = {
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false
}

function reportFor(authority, overrides = {}) {
  return {
    valid: true,
    authority,
    ...safety,
    errors: [],
    ...overrides
  }
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function createBundle(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-attestation-artifacts-'))
  for (const [name, authority] of Object.entries(authorities)) {
    const content = `${JSON.stringify(reportFor(authority, overrides[name]), null, 2)}\n`
    await fs.writeFile(path.join(directory, name), content)
    await fs.writeFile(path.join(directory, `${name}.sha256`), `${digest(content)}  artifacts/${name}\n`)
  }
  if (overrides.unexpected) await fs.writeFile(path.join(directory, 'unexpected.json'), '{}\n')
  if (overrides.unexpectedDirectory) await fs.mkdir(path.join(directory, 'unexpected-directory'))
  if (overrides.invalidJson) await fs.writeFile(path.join(directory, overrides.invalidJson), '{not-json\n')
  if (overrides.missingSidecar) await fs.rm(path.join(directory, `${overrides.missingSidecar}.sha256`), { force: true })
  if (overrides.malformedSidecar) await fs.writeFile(path.join(directory, `${overrides.malformedSidecar}.sha256`), 'not-a-sha256-sidecar\n')
  if (overrides.symlinkSidecar) {
    const sidecarPath = path.join(directory, `${overrides.symlinkSidecar}.sha256`)
    await fs.rm(sidecarPath, { force: true })
    await fs.symlink(sidecarPath, sidecarPath)
  }
  if (overrides.unexpectedSidecar) await fs.writeFile(path.join(directory, 'unexpected.sha256'), `${'0'.repeat(64)}  artifacts/unexpected.json\n`)
  if (overrides.sidecarReference) {
    const reportPath = path.join(directory, 'migration-source-traceability.json')
    const content = await fs.readFile(reportPath, 'utf8')
    await fs.writeFile(`${reportPath}.sha256`, `${digest(content)}  ${overrides.sidecarReference}\n`)
  }
  if (overrides.symlink) {
    await fs.rm(path.join(directory, overrides.symlink), { force: true })
    await fs.symlink(path.join(directory, 'migration-source-traceability.json'), path.join(directory, overrides.symlink))
  }
  if (overrides.tamper) await fs.appendFile(path.join(directory, overrides.tamper), '\n')
  return directory
}

function runAudit(directory) {
  const outputPath = path.join(directory, 'release-attestation-artifacts.json')
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, directory, outputPath], {
      cwd: backendDirectory,
      encoding: 'utf8'
    })
    return { status: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { status: error.status, report: JSON.parse(String(error.stderr)) }
  }
}

describe('release-attestation artifact retention contract', () => {
  it('verifies all five reports, sidecars, authority fields, and repeated execution', async () => {
    const directory = await createBundle()
    try {
      const first = runAudit(directory)
      const second = runAudit(directory)
      expect(first.status).toBe(0)
      expect(second.status).toBe(0)
      expect(first.report.valid).toBe(true)
      expect(second.report.valid).toBe(true)
      expect(Object.values(second.report.checks).every((check) => check.valid)).toBe(true)
      expect(second.report.authority).toBe('artifact_retention_audit_only')
      expect(second.report.releaseEligible).toBe(false)
      expect(second.report.mutation).toBe('read_only')
      const packageJson = JSON.parse(await fs.readFile(path.join(repositoryDirectory, 'package.json'), 'utf8'))
      const workflow = await fs.readFile(path.join(repositoryDirectory, '.github/workflows/paytray-quality.yml'), 'utf8')
      expect(packageJson.scripts['backend:release:attestation:artifacts:check']).toBe('node packages/backend/scripts/verify-release-attestation-artifacts.mjs')
      expect(packageJson.scripts['backend:release:downstream:boundary:check']).toBe('node packages/backend/scripts/verify-downstream-integration-boundaries.mjs')
      expect(workflow).toContain('Verify downstream integration boundary')
      expect(workflow).toContain('DOWNSTREAM_INTEGRATION_BOUNDARY_OUTPUT_PATH=artifacts/downstream-integration-boundary.json')
      expect(workflow).toContain('artifacts/downstream-integration-boundary.json.sha256')
      expect(workflow).toContain('Verify release-attestation artifact retention')
      expect(workflow).toContain('RELEASE_ATTESTATION_ARTIFACT_OUTPUT_PATH=artifacts/release-attestation-artifacts.json')
      expect(workflow).toContain('artifacts/release-attestation-artifacts.json.sha256')
      expect(workflow).toContain('if-no-files-found: error')
      expect(workflow).toContain('retention-days: 7')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['a missing report', {}, 'migration-runtime-races.json'],
    ['a checksum mismatch', { tamper: 'migration-source-traceability.json' }, 'migration-source-traceability.json'],
    ['unexpected JSON', { unexpected: true }, 'unexpected.json'],
    ['unexpected sidecar', { unexpectedSidecar: true }, 'unexpected.sha256'],
    ['unexpected directory', { unexpectedDirectory: true }, 'unexpected-directory'],
    ['invalid JSON', { invalidJson: 'migration-source-traceability.json' }, 'migration-source-traceability.json'],
    ['a missing sidecar', { missingSidecar: 'migration-runtime-races.json' }, 'migration-runtime-races.json'],
    ['a malformed sidecar', { malformedSidecar: 'migration-runtime-races.json' }, 'migration-runtime-races.json'],
    ['a substituted sidecar path', { sidecarReference: 'artifacts/other.json' }, 'migration-source-traceability.json'],
    ['a symlinked report', { symlink: 'migration-source-traceability.json' }, 'migration-source-traceability.json'],
    ['a symlinked sidecar', { symlinkSidecar: 'migration-source-traceability.json' }, 'migration-source-traceability.json'],
    ['sensitive material', { 'migration-future-boundary.json': { secret: 'PRIVATE_KEY=forbidden' } }, 'migration-future-boundary.json'],
    ['an authority mismatch', { 'migration-race-boundaries.json': { authority: 'release_authority' } }, 'migration-race-boundaries.json'],
    ['an unsafe release field', { 'migration-future-boundary.json': { releaseEligible: true } }, 'migration-future-boundary.json']
  ])('blocks %s while preserving immutable safety fields', async (_label, overrides, expectedArtifact) => {
    const directory = await createBundle(overrides)
    try {
      if (_label === 'a missing report') await fs.rm(path.join(directory, expectedArtifact))
      const result = runAudit(directory)
      expect(result.status).toBe(1)
      expect(result.report.valid).toBe(false)
      expect(result.report.errors.some((error) => error.artifact === expectedArtifact)).toBe(true)
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
