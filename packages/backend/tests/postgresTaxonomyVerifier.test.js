import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-postgres-taxonomy.mjs')

function taxonomy(records) {
  return {
    run: 'test-run',
    commit: 'test-commit',
    categories: {
      postgresConstraintNegativePath: {
        lines: records
      }
    }
  }
}

function record(logLine, raw, job = 'Isolated PostgreSQL route contract', step = 'negative assertion') {
  return { logLine, job, step, raw }
}

describe('PostgreSQL taxonomy verifier', () => {
  it('validates unique line numbers, owning jobs, and all four PostgreSQL families', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-postgres-taxonomy-'))
    try {
      const inputPath = path.join(directory, 'taxonomy.json')
      const outputPath = path.join(directory, 'verification.json')
      const records = [
        record(11, 'ERROR: duplicate key value violates unique constraint "demo_unique"'),
        record(12, 'ERROR: new row violates check constraint "demo_check"'),
        record(13, 'ERROR: insert or update violates foreign key constraint "demo_fk"'),
        record(14, 'ERROR: null value in column "demo" violates not-null constraint')
      ]
      await fs.writeFile(inputPath, JSON.stringify(taxonomy(records)))
      const summary = JSON.parse(execFileSync(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8',
        env: { ...process.env, EXPECT_POSTGRES_RECORD_COUNT: '4' }
      }))
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(summary.valid).toBe(true)
      expect(report.recordCount).toBe(4)
      expect(report.constraintFamilyCounts).toEqual({ check: 1, foreign_key: 1, not_null: 1, unique: 1 })
      expect(report.allRecordsHaveUniqueLineNumbers).toBe(true)
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

  it('fails closed for duplicate log lines, unsupported jobs, and missing PostgreSQL markers', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-postgres-taxonomy-invalid-'))
    try {
      const inputPath = path.join(directory, 'taxonomy.json')
      const outputPath = path.join(directory, 'verification.json')
      await fs.writeFile(inputPath, JSON.stringify(taxonomy([
        record(21, 'ERROR: duplicate key value violates unique constraint "demo_unique"'),
        record(21, 'not a PostgreSQL diagnostic', 'unexpected job', '')
      ])))
      expect(() => execFileSync(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8',
        env: { ...process.env, EXPECT_POSTGRES_RECORD_COUNT: '2' }
      })).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.valid).toBe(false)
      expect(report.errors.map((error) => error.error)).toEqual(expect.arrayContaining([
        'duplicate log line number',
        'missing PostgreSQL error marker',
        'expected one constraint family; found none',
        'unexpected owning job',
        'missing owning step'
      ]))
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
