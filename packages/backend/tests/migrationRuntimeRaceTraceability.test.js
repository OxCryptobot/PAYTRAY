import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const backendDirectory = process.cwd()
const repositoryPath = path.resolve(backendDirectory, '..', '..')
const scriptPath = path.join(backendDirectory, 'scripts', 'verify-migration-runtime-races.mjs')

function runAudit(targetRepository, outputPath) {
  return execFileSync(process.execPath, [scriptPath, targetRepository, outputPath], {
    cwd: backendDirectory,
    encoding: 'utf8'
  })
}

async function createFixture(root, omitPattern = null) {
  const contracts = [
    ['006', 'ai_evaluation_foundation', 'verify-migration-006-ai-evaluation-foundation.mjs', 'exampleRace', 'concurrentDuplicateEvaluationExample', 'insertEvaluationExample', 'ai_shadow_decisions'],
    ['007', 'discovery_impressions', 'verify-migration-007-discovery-impressions.mjs', 'impressionRace', 'concurrentDuplicateQueryCandidate', 'insertImpression', 'discovery_impressions'],
    ['008', 'production_telemetry', 'verify-migration-008-production-telemetry.mjs', 'eventRace', 'concurrentDuplicateEventId', 'insertEvent', 'production_telemetry_events'],
    ['009', 'verified_outcome_provenance', 'verify-migration-009-verified-outcome-provenance.mjs', null, null, null, 'engagement_outcome_events']
  ]
  const migrationDirectory = path.join(root, 'packages/backend/migrations')
  const scriptDirectory = path.join(root, 'packages/backend/scripts')
  await fs.mkdir(migrationDirectory, { recursive: true })
  await fs.mkdir(scriptDirectory, { recursive: true })
  for (const [number, migrationName, verifierName, helper, reportCase, insertHelper, cleanupTable] of contracts) {
    await fs.writeFile(path.join(migrationDirectory, `${number}_${migrationName}.sql`), `CREATE TABLE ${cleanupTable} (id uuid);`)
    const activeRace = helper === null ? '' : `function ${helper}() { const outcomes = Promise.all(Array.from({ length: attempts })); const winners = []; const losers = []; const attempts = 4; withTransaction(pool, (client) => ${insertHelper}(client)); if (winners.length !== 1) throw new Error('winner'); if (losers.length !== attempts - 1) throw new Error('loser'); if (losers.every((outcome) => outcome.sqlState === '23505')) return; }`
    const report = reportCase === null ? 'const reportCase = true;' : `const ${reportCase} = { status: 'verified', attempts, repetitions, totalAttempts };`
    const noRace = helper === null ? `function verifyCatalog() {} const verification_evidence_hash = true; const invalidStatus = '23514'; const oversizedHash = '22001';` : ''
    const cleanup = `try { return true; } finally { DELETE FROM ${cleanupTable}; }`
    const source = `${activeRace} ${report} ${noRace} ${cleanup} const releaseEligible = false; const settlementAuthority = false; const mutation = 'read_only'; const deploymentPerformed = false; const settlementMutationPerformed = false;`
    const mutated = omitPattern && omitPattern.verifierName === verifierName ? source.replace(omitPattern.pattern, omitPattern.replacement) : source
    await fs.writeFile(path.join(scriptDirectory, verifierName), mutated)
  }
}

describe('migration runtime race traceability', () => {
  it('maps the three active runtime race helpers and migration-009 no-race behavior', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-runtime-race-trace-'))
    try {
      const outputPath = path.join(directory, 'runtime-races.json')
      const report = JSON.parse(runAudit(repositoryPath, outputPath))
      expect(report.valid).toBe(true)
      expect(report.migrations).toHaveLength(4)
      expect(report.migrations.slice(0, 3).every((migration) => migration.valid)).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.patternPresence['one winner'])).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.patternPresence['attempts-minus-one losers'])).toBe(true)
      expect(report.migrations.slice(0, 3).every((migration) => migration.patternPresence['SQLSTATE 23505 losers'])).toBe(true)
      expect(report.migrations[3].noRacePatternPresence).toEqual({ 'no Promise.all': true, 'no race helper': true, 'no repetition race loop': true })
      expect(report.authority).toBe('runtime_race_traceability_audit_only')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when migration-008 loses its attempts-minus-one assertion', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-runtime-race-trace-invalid-'))
    try {
      const fakeRepository = path.join(directory, 'repo')
      await createFixture(fakeRepository, {
        verifierName: 'verify-migration-008-production-telemetry.mjs',
        pattern: 'losers.length !== attempts - 1',
        replacement: 'losers.length !== attempts'
      })
      const outputPath = path.join(directory, 'runtime-races.json')
      expect(() => runAudit(fakeRepository, outputPath)).toThrow()
      const report = JSON.parse(await fs.readFile(outputPath, 'utf8'))
      const migration = report.migrations.find((entry) => entry.migration === '008_production_telemetry')
      expect(report.valid).toBe(false)
      expect(migration.valid).toBe(false)
      expect(migration.patternPresence['attempts-minus-one losers']).toBe(false)
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
