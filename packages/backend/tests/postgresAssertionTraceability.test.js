import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryPath = path.resolve(process.cwd(), '..', '..')
const backendDirectory = process.cwd()
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-postgres-assertion-traceability.mjs')

const migrationIds = [
  '001_init',
  '002_financial_core',
  '003_discovery_v1',
  '004_engagement_context',
  '005_outcomes_and_metrics',
  '006_ai_evaluation_foundation',
  '007_discovery_impressions',
  '008_production_telemetry',
  '009_verified_outcome_provenance'
]

describe('PostgreSQL assertion traceability', () => {
  it('maps migration-001 through migration-009 verifier cases to SQLSTATE and schema contracts', async () => {
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
      expect(report.migrations).toHaveLength(9)
      expect(report.migrations.map((migration) => migration.migration)).toEqual(migrationIds)
      expect(report.migrations.every((migration) => migration.valid)).toBe(true)
      expect(report.migrations[0].expectedCaseStates).toMatchObject({
        duplicateWallet: '23505',
        missingProfileUser: '23503',
        nullWalletAddress: '23502'
      })
      expect(report.migrations[1].racePresence.status).toBe('present')
      expect(report.migrations[2].racePresence.status).toBe('not_applicable')
      expect(report.migrations[3].expectedCaseStates).toMatchObject({
        invalidCollaboration: '23514',
        nullDiscoveryContext: '23502'
      })
      expect(report.migrations[4].racePresence).toMatchObject({
        status: 'present',
        cases: { duplicateOutcomeRace: true, verifierTransitionRace: true }
      })
      expect(report.migrations[7].expectedCaseStates).toEqual({
        duplicateEventId: '23505',
        invalidEventType: '23514',
        invalidPrivacyClass: '23514'
      })
      expect(report.migrations[8].expectedCaseStates).toEqual({
        invalidStatus: '23514',
        oversizedHash: '22001'
      })
      expect(report.migrations[8].racePresence.status).toBe('not_applicable')
      expect(report.expectedSqlStateLiterals).toEqual(['23505', '23503', '23502', '23514', '22001'])
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
      for (const migration of migrationIds) {
        const [id, ...name] = migration.split('_')
        await fs.writeFile(path.join(fakeRepository, 'packages/backend/migrations', `${id}_${name.join('_')}.sql`), '')
        await fs.writeFile(path.join(fakeRepository, 'packages/backend/scripts', `verify-migration-${id}-${name.join('-')}.mjs`), '')
      }
      const outputPath = path.join(directory, 'traceability.json')
      expect(() => execFileSync(process.execPath, [scriptPath, fakeRepository, outputPath], {
        cwd: backendDirectory,
        encoding: 'utf8'
      })).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.valid).toBe(false)
      expect(report.errors).toHaveLength(9)
      expect(report.errors.every((error) => error.result.valid === false)).toBe(true)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
