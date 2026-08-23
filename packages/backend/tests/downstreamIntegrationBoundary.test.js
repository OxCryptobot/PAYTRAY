import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const repositoryDirectory = path.resolve(backendDirectory, '../..')
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-downstream-integration-boundaries.mjs')
const sourceFiles = [
  'package.json',
  '.github/workflows/paytray-quality.yml',
  'packages/client/smoke-test.mjs',
  'packages/backend/tests/api.test.js',
  'packages/backend/tests/outboxProcessor.test.js',
  'packages/backend/tests/webhookReplayLoad.test.js',
  'packages/backend/scripts/verify-ready-postgres-contracts.mjs'
]

function runAudit(repoPath, outputPath) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, outputPath], {
      cwd: backendDirectory,
      encoding: 'utf8',
      env: { ...process.env, DOWNSTREAM_INTEGRATION_REPOSITORY_PATH: repoPath }
    })
    return { status: 0, report: JSON.parse(stdout) }
  } catch (error) {
    return { status: error.status, report: JSON.parse(String(error.stderr)) }
  }
}

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-downstream-boundary-'))
  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(repositoryDirectory, relativePath)
    const targetPath = path.join(directory, relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
  }
  return directory
}

describe('downstream integration boundary contract', () => {
  it('verifies the real client, API, outbox, replay-load, and ready-PostgreSQL contracts', () => {
    const outputPath = path.join(os.tmpdir(), 'paytray-downstream-boundary-real.json')
    const result = runAudit(repositoryDirectory, outputPath)
    expect(result.status).toBe(0)
    expect(result.report.valid).toBe(true)
    expect(Object.values(result.report.checks).every((check) => check.valid)).toBe(true)
    expect(result.report.authority).toBe('downstream_integration_boundary_audit_only')
    expect(result.report.releaseEligible).toBe(false)
    expect(result.report.settlementAuthority).toBe(false)
    expect(result.report.mutation).toBe('read_only')
    expect(result.report.deploymentPerformed).toBe(false)
    expect(result.report.settlementMutationPerformed).toBe(false)
  })

  it('blocks a mutated client port binding while preserving immutable safety fields', async () => {
    const directory = await createFixture()
    try {
      const clientPath = path.join(directory, 'packages/client/smoke-test.mjs')
      const clientSource = await fs.readFile(clientPath, 'utf8')
      expect(clientSource).toContain("'127.0.0.1'")
      const mutatedClientSource = clientSource.replace("'127.0.0.1'", "'0.0.0.0'")
      expect(mutatedClientSource).not.toBe(clientSource)
      expect(mutatedClientSource).not.toContain("'127.0.0.1'")
      await fs.writeFile(clientPath, mutatedClientSource)
      const result = runAudit(directory, path.join(directory, 'downstream-boundary.json'))
      expect(result.status).toBe(1)
      expect(result.report.valid).toBe(false)
      expect(result.report.errors.some((error) => error.check === 'clientSmoke' && error.reason.includes("required marker is missing: server.listen(Number.isInteger(requestedPort) ? requestedPort : 0, '127.0.0.1'"))).toBe(true)
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
