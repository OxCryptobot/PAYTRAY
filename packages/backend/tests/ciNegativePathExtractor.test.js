import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'extract-ci-negative-lines.mjs')

describe('CI negative-path extractor', () => {
  it('preserves source lines and applies the documented category precedence', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-ci-negative-'))
    try {
      const inputPath = path.join(directory, 'ci.log')
      const outputPath = path.join(directory, 'taxonomy.json')
      await fs.writeFile(inputPath, [
        'postgres-contract\tnegative route\tERROR ErrorHandler expected request rejection',
        'postgres-contract\tnegative sql\tERROR duplicate key value violates unique constraint',
        'unit\tstderr\tstderr expected failure-mode diagnostic',
        'release\tartifact\tERROR artifacts/restored-migration-001-bootstrap.json status error',
        'plain\tother\tERROR informational marker requiring review'
      ].join('\n'))
      const summary = JSON.parse(execFileSync(process.execPath, [scriptPath, inputPath, outputPath], { cwd: backendDirectory, encoding: 'utf8' }))
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(summary.routeNegativeLines).toBe(1)
      expect(summary.postgresNegativeLines).toBe(1)
      expect(summary.processFailureLines).toBe(0)
      expect(summary.processFailureFree).toBe(true)
      expect(report.totalErrorLikeLines).toBe(5)
      expect(report.categories.errorHandlerNegativePath.lines[0]).toMatchObject({ logLine: 1, job: 'postgres-contract', step: 'negative route' })
      expect(report.categories.postgresConstraintNegativePath.lines[0]).toMatchObject({ logLine: 2, job: 'postgres-contract', step: 'negative sql' })
      expect(report.categories.expectedTestStderr.count).toBe(1)
      expect(report.categories.expectedArtifactStatus.count).toBe(1)
      expect(report.categories.otherErrorLike.count).toBe(1)
      expect(report.authority).toBe('ci_log_audit_only')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('writes the report and exits nonzero when a process-failure signal is present', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-ci-negative-failure-'))
    try {
      const inputPath = path.join(directory, 'ci.log')
      const outputPath = path.join(directory, 'taxonomy.json')
      await fs.writeFile(inputPath, 'job\tstep\tERROR Process completed with exit code 1')
      expect(() => execFileSync(process.execPath, [scriptPath, inputPath, outputPath], { cwd: backendDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.categories.processFailureSignal.count).toBe(1)
      expect(report.processFailureFree).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
