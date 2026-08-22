import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'audit-ci-warning-signals.mjs')

describe('CI warning signal auditor', () => {
  it('accepts a warning-free successful log and preserves the audit-only boundary', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-ci-warning-clean-'))
    try {
      const inputPath = path.join(directory, 'ci.log')
      const outputPath = path.join(directory, 'audit.json')
      await fs.writeFile(inputPath, 'Process completed with exit code 0\nJob completed successfully\n')
      const summary = JSON.parse(execFileSync(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8'
      }))
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(summary.valid).toBe(true)
      expect(report.warningCount).toBe(0)
      expect(report.processFailureCount).toBe(0)
      expect(report.warningFree).toBe(true)
      expect(report.processFailureFree).toBe(true)
      expect(report.authority).toBe('ci_log_audit_only')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
      expect(report.deploymentPerformed).toBe(false)
      expect(report.settlementMutationPerformed).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('reports warning and deprecation lines without failing permissive audit mode', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-ci-warning-permissive-'))
    try {
      const inputPath = path.join(directory, 'ci.log')
      const outputPath = path.join(directory, 'audit.json')
      await fs.writeFile(inputPath, 'npm warn deprecated package@1.0.0\n(node:1) [DEP0001] DeprecationWarning: legacy API\nProcess completed with exit code 0\n')
      const summary = JSON.parse(execFileSync(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8'
      }))
      expect(summary.valid).toBe(true)
      expect(summary.warningCount).toBe(2)
      expect(summary.warningFree).toBe(false)
      expect(summary.processFailureFree).toBe(true)
      expect(summary.failOnWarnings).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed in strict warning mode and for process-failure signals', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-ci-warning-strict-'))
    try {
      const inputPath = path.join(directory, 'ci.log')
      const outputPath = path.join(directory, 'audit.json')
      await fs.writeFile(inputPath, 'warning: deprecated fixture\nProcess completed with exit code 1\nFATAL: contract failure\n')
      expect(() => execFileSync(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8',
        env: { ...process.env, CI_FAIL_ON_WARNINGS: 'true' }
      })).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.valid).toBe(false)
      expect(report.warningCount).toBe(1)
      expect(report.processFailureCount).toBe(2)
      expect(report.failOnWarnings).toBe(true)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
