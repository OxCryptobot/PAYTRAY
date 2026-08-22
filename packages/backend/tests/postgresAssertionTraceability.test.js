import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryPath = path.resolve(process.cwd(), '..', '..')
const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-postgres-assertion-traceability.mjs')

describe('PostgreSQL assertion traceability', () => {
  it('maps migration-006 and migration-007 verifier cases to SQLSTATE and schema contracts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-postgres-trace-'))
    try {
      const outputPath = path.join(directory, 'traceability.json')
      const stdout = execFileSync(process.execPath, [scriptPath, repositoryPath, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8'
      })
      const summary = JSON.parse(stdout)
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(summary.valid).toBe(true)
      expect(report.migrations).toHaveLength(2)
      expect(report.migrations.map((migration) => migration.migration)).toEqual([
        '006_ai_evaluation_foundation',
        '007_discovery_impressions'
      ])
      expect(report.migrations.every((migration) => migration.valid)).toBe(true)
      expect(report.authority).toBe('assertion_traceability_audit_only')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
      expect(report.deploymentPerformed).toBe(false)
      expect(report.settlementMutationPerformed).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when a verifier case, SQLSTATE literal, race, schema matcher, or safety field is absent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-postgres-trace-invalid-'))
    try {
      const fakeRepository = path.join(directory, 'repo')
      await fs.mkdir(path.join(fakeRepository, 'packages/backend/migrations'), { recursive: true })
      await fs.mkdir(path.join(fakeRepository, 'packages/backend/scripts'), { recursive: true })
      await fs.writeFile(path.join(fakeRepository, 'packages/backend/migrations/006_ai_evaluation_foundation.sql'), 'CREATE TABLE ai_evaluation_examples (UNIQUE (dataset_version, query_id, candidate_profile_id, split));')
      await fs.writeFile(path.join(fakeRepository, 'packages/backend/migrations/007_discovery_impressions.sql'), 'CREATE TABLE discovery_impressions (CHECK (rank_position > 0), CHECK (baseline_score >= 0 AND baseline_score <= 100), UNIQUE (query_id, candidate_profile_id));')
      await fs.writeFile(path.join(fakeRepository, 'packages/backend/scripts/verify-migration-006-ai-evaluation-foundation.mjs'), "const duplicateEvaluationExample = '23505'\n")
      await fs.writeFile(path.join(fakeRepository, 'packages/backend/scripts/verify-migration-007-discovery-impressions.mjs'), "const duplicateQueryCandidate = '23505'\n")
      const outputPath = path.join(directory, 'traceability.json')
      expect(() => execFileSync(process.execPath, [scriptPath, fakeRepository, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8'
      })).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.valid).toBe(false)
      expect(report.errors).toHaveLength(2)
      expect(report.errors.every((error) => error.result.valid === false)).toBe(true)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
