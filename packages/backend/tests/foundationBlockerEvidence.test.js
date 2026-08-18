import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFoundationBlockerEvidence } from '../scripts/verify-foundation-blocker-evidence.mjs'

const releaseCommit = 'a'.repeat(40)
const migrationNames = ['001_init', '002_financial_core', '003_discovery_v1', '004_engagement_context', '005_outcomes_and_metrics', '006_ai_evaluation_foundation', '007_discovery_impressions', '008_production_telemetry', '009_verified_outcome_provenance', '010_ledger_intent_idempotency', '011_payment_stream_verifier_provenance', '012_shadow_run_review', '013_verifier_cursors', '014_webhook_replay_claims', '015_verified_trust_signals', '016_webhook_inbox', '017_extension_hooks', '018_operations_quality_runs', '019_reviewer_attestations']

function writeFixture(root, name, report) {
  const filePath = path.join(root, name)
  fs.writeFileSync(filePath, JSON.stringify(report), { mode: 0o600 })
  return filePath
}

function baseMigration(overrides = {}) {
  return { reportKind: 'migration_evidence', status: 'ok', databaseStatus: 'ready', schemaContractsPassed: true, migrationNames, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, ...overrides }
}

function baseRailway(overrides = {}) {
  return { reportKind: 'railway_trial_evidence', status: 'match', preflight: { ready: true, settlement: { chainId: 84532, mainnetEnabled: false } }, trialUrl: { configured: true }, settingsComparison: { status: 'match' }, railwayMetadata: { status: 'observed' }, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false, ...overrides }
}

describe('foundation blocker evidence verifier', () => {
  it('verifies complete redacted migration and Railway references without granting authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-evidence-'))
    try {
      const migrationPath = writeFixture(root, 'migration.json', baseMigration())
      const railwayPath = writeFixture(root, 'railway.json', baseRailway())
      const result = buildFoundationBlockerEvidence({ migrationEvidenceFile: migrationPath, railwayEvidenceFile: railwayPath, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ reportKind: 'foundation_blocker_evidence', status: 'verified_reference', evidenceCount: 2, verifiedReferenceCount: 2, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false })
      expect(result.blockers.map((item) => item.status)).toEqual(['verified_reference', 'verified_reference'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps incomplete migration or Railway evidence blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-blocked-'))
    try {
      const migrationPath = writeFixture(root, 'migration.json', baseMigration({ migrationNames: migrationNames.slice(0, -1) }))
      const railwayPath = writeFixture(root, 'railway.json', baseRailway({ status: 'metadata_unavailable', railwayMetadata: { status: 'not_observed' } }))
      const result = buildFoundationBlockerEvidence({ migrationEvidenceFile: migrationPath, railwayEvidenceFile: railwayPath, target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ status: 'blocked', verifiedReferenceCount: 0, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(result.blockers.map((item) => item.nextAction)).toEqual(expect.arrayContaining([expect.stringContaining('ready target PostgreSQL'), expect.stringContaining('authenticated redacted Railway settings')]))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds both evidence files to the requested exact commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-commit-'))
    try {
      const migrationPath = writeFixture(root, 'migration.json', { ...baseMigration(), releaseCommit: 'b'.repeat(40) })
      const railwayPath = writeFixture(root, 'railway.json', baseRailway())
      expect(() => buildFoundationBlockerEvidence({ migrationEvidenceFile: migrationPath, railwayEvidenceFile: railwayPath, target: 'local_disposable', releaseCommit })).toThrow('does not match')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects sensitive content and authenticated paths outside the protected root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-sensitive-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-outside-'))
    try {
      const sensitivePath = writeFixture(root, 'migration.json', { ...baseMigration(), rawSignature: 'never' })
      const railwayPath = writeFixture(root, 'railway.json', baseRailway())
      expect(() => buildFoundationBlockerEvidence({ migrationEvidenceFile: sensitivePath, railwayEvidenceFile: railwayPath, target: 'local_disposable', releaseCommit })).toThrow('sensitive key')
      const outsideMigration = writeFixture(outside, 'migration.json', baseMigration())
      expect(() => buildFoundationBlockerEvidence({ migrationEvidenceFile: outsideMigration, railwayEvidenceFile: railwayPath, target: 'authenticated_target', releaseCommit })).toThrow('inside the protected evidence root')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('produces stable SHA-256-bound source metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-foundation-sha-'))
    try {
      const migrationPath = writeFixture(root, 'migration.json', baseMigration())
      const railwayRaw = JSON.stringify(baseRailway())
      const railwayPath = path.join(root, 'railway.json')
      fs.writeFileSync(railwayPath, railwayRaw, { mode: 0o600 })
      const result = buildFoundationBlockerEvidence({ migrationEvidenceFile: migrationPath, railwayEvidenceFile: railwayPath, target: 'local_disposable', releaseCommit })
      expect(result.blockers[1].sourceSha256).toBe(createHash('sha256').update(railwayRaw).digest('hex'))
      expect(result.blockers[1].releaseCommit).toBe(releaseCommit)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
