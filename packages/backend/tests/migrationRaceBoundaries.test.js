import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const repositoryPath = path.resolve(backendDirectory, '..', '..')
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-migration-race-boundaries.mjs')

const contracts = [
  ['006', 'ai_evaluation_foundation', 'ai_evaluation_examples', 'verify-migration-006-ai-evaluation-foundation.mjs', 'concurrentDuplicateEvaluationExample'],
  ['007', 'discovery_impressions', 'discovery_impressions', 'verify-migration-007-discovery-impressions.mjs', 'concurrentDuplicateQueryCandidate'],
  ['008', 'production_telemetry', 'production_telemetry_events', 'verify-migration-008-production-telemetry.mjs', 'concurrentDuplicateEventId'],
  ['009', 'verified_outcome_provenance', 'engagement_outcome_events', 'verify-migration-009-verified-outcome-provenance.mjs', null]
]

function runAudit(targetRepository, outputPath) {
  return execFileSync(process.execPath, [scriptPath, targetRepository, outputPath], {
    cwd: backendDirectory,
    encoding: 'utf8'
  })
}

async function createFixture(root) {
  for (const [number, migrationName, tableName, verifierName, raceCase] of contracts) {
    const migrationDirectory = path.join(root, 'packages/backend/migrations')
    const scriptDirectory = path.join(root, 'packages/backend/scripts')
    await fs.mkdir(migrationDirectory, { recursive: true })
    await fs.mkdir(scriptDirectory, { recursive: true })
    await fs.writeFile(path.join(migrationDirectory, `${number}_${migrationName}.sql`), `CREATE TABLE ${tableName} (id uuid);`)
    const raceSource = raceCase === null
      ? ''
      : `function ${raceCase}() { const winners = []; const losers = []; const attempts = 4; if (winners.length !== 1) throw new Error('winner'); if (losers.length !== attempts - 1) throw new Error('loser'); if ('23505' !== '23505') throw new Error('sqlstate'); }`
    const source = `const safety = true; ${raceSource} const releaseEligible = false; const settlementAuthority = false; const mutation = 'read_only'; const deploymentPerformed = false; const settlementMutationPerformed = false;`
    await fs.writeFile(path.join(scriptDirectory, verifierName), source)
  }
}

describe('migration race-boundary verifier', () => {
  it('verifies duplicate-write race invariants for 006–008 and explicit no-race for 009', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-race-boundaries-'))
    try {
      const outputPath = path.join(directory, 'race-boundaries.json')
      const report = JSON.parse(runAudit(repositoryPath, outputPath))
      expect(report.valid).toBe(true)
      expect(report.migrations).toHaveLength(4)
      expect(report.migrations.slice(0, 3).every((migration) => migration.raceCasePresent)).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.markerPresence['winner cardinality'])).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.markerPresence['loser cardinality'])).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.markerPresence['attempt bound'])).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.markerPresence['duplicate loser SQLSTATE'])).toBe(true)
      expect(report.migrations[3].noRaceBoundary).toMatchObject({ status: 'not_applicable', raceMarkersAbsent: true })
      expect(report.authority).toBe('race_boundary_audit_only')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
      expect(report.deploymentPerformed).toBe(false)
      expect(report.settlementMutationPerformed).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when a required race marker is absent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-race-boundaries-invalid-'))
    try {
      const fakeRepository = path.join(directory, 'repo')
      await createFixture(fakeRepository)
      const verifierPath = path.join(fakeRepository, 'packages/backend/scripts/verify-migration-007-discovery-impressions.mjs')
      const verifier = await fs.readFile(verifierPath, 'utf8')
      await fs.writeFile(verifierPath, verifier.replace('losers.length', 'loserCount'))
      const outputPath = path.join(directory, 'race-boundaries.json')
      expect(() => runAudit(fakeRepository, outputPath)).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      expect(report.valid).toBe(false)
      const migration = report.migrations.find((entry) => entry.migration === '007_discovery_impressions')
      expect(migration.valid).toBe(false)
      expect(migration.markerPresence['loser cardinality']).toBe(false)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
