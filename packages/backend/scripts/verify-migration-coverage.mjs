#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')
const REPO_DIR = path.resolve(BACKEND_DIR, '../..')
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'migrations')
const PACKAGE_JSON = path.join(REPO_DIR, 'package.json')
const WORKFLOW = path.join(REPO_DIR, '.github/workflows/paytray-quality.yml')
const RECOVERY_VERIFIER = path.join(__dirname, 'verify-recovery-artifact.mjs')
const ISOLATED = process.env.MIGRATION_COVERAGE_AUDIT_ISOLATED === 'true'

const EXPECTED = new Map([
  ['001', { migration: '001_init', verifier: 'verify-migration-001-bootstrap.mjs', script: 'backend:release:migration:001:check', isolatedStep: 'Verify migration-001 bootstrap schema', restoredStep: 'Verify restored migration-001 bootstrap schema', artifact: 'restored-migration-001-bootstrap.json' }],
  ['002', { migration: '002_financial_core', verifier: 'verify-migration-002-financial-core.mjs', script: 'backend:release:migration:002:check', isolatedStep: 'Verify migration-002 financial core', restoredStep: 'Verify restored migration-002 financial core', artifact: 'restored-migration-002-financial-core.json' }],
  ['003', { migration: '003_discovery_v1', verifier: 'verify-migration-003-discovery-v1.mjs', script: 'backend:release:migration:003:check', isolatedStep: 'Verify migration-003 discovery v1', restoredStep: 'Verify restored migration-003 discovery v1', artifact: 'restored-migration-003-discovery-v1.json' }],
  ['004', { migration: '004_engagement_context', verifier: 'verify-migration-004-engagement-context.mjs', script: 'backend:release:migration:004:check', isolatedStep: 'Verify migration-004 engagement context', restoredStep: 'Verify restored migration-004 engagement context', artifact: 'restored-migration-004-engagement-context.json' }],
  ['005', { migration: '005_outcomes_and_metrics', verifier: 'verify-migration-005-outcome-lineage.mjs', script: 'backend:release:migration:005:check', isolatedStep: 'Verify migration-005 outcome lineage', restoredStep: 'Verify restored migration-005 outcome lineage', artifact: 'restored-migration-005-outcome-lineage.json' }],
  ['006', { migration: '006_ai_evaluation_foundation', verifier: 'verify-migration-006-ai-evaluation-foundation.mjs', script: 'backend:release:migration:006:check', isolatedStep: 'Verify migration-006 AI evaluation foundation', restoredStep: 'Verify restored migration-006 AI evaluation foundation', artifact: 'restored-migration-006-ai-evaluation-foundation.json' }],
  ['007', { migration: '007_discovery_impressions', verifier: 'verify-migration-007-discovery-impressions.mjs', script: 'backend:release:migration:007:check', isolatedStep: 'Verify migration-007 discovery impressions', restoredStep: 'Verify restored migration-007 discovery impressions', artifact: 'restored-migration-007-discovery-impressions.json' }],
  ['008', { migration: '008_production_telemetry', verifier: 'verify-migration-008-production-telemetry.mjs', script: 'backend:release:migration:008:check', isolatedStep: 'Verify migration-008 production telemetry', restoredStep: 'Verify restored migration-008 production telemetry', artifact: 'restored-migration-008-production-telemetry.json' }],
  ['009', { migration: '009_verified_outcome_provenance', verifier: 'verify-migration-009-verified-outcome-provenance.mjs', script: 'backend:release:migration:009:check', isolatedStep: 'Verify migration-009 verified-outcome provenance', restoredStep: 'Verify restored migration-009 verified-outcome provenance', artifact: 'restored-migration-009-verified-outcome-provenance.json' }],
  ['010', { migration: '010_ledger_intent_idempotency', verifier: 'verify-migration-010-ledger-intent-idempotency.mjs', script: 'backend:release:migration:010:check', isolatedStep: 'Verify migration-010 ledger intent idempotency', restoredStep: 'Verify restored migration-010 ledger intent idempotency', artifact: 'restored-migration-010-ledger-intent-idempotency.json' }],
  ['011', { migration: '011_payment_stream_verifier_provenance', verifier: 'verify-migration-011-payment-provenance.mjs', script: 'backend:release:migration:011:check', isolatedStep: 'Verify migration-011 payment-stream provenance', restoredStep: 'Verify restored migration-011 payment-stream provenance', artifact: 'restored-migration-011-payment-provenance.json' }],
  ['012', { migration: '012_shadow_run_review', verifier: 'verify-migration-012-shadow-run-review.mjs', script: 'backend:release:migration:012:check', isolatedStep: 'Verify migration-012 shadow-run review', restoredStep: 'Verify restored migration-012 shadow-run review', artifact: 'restored-migration-012-shadow-run-review.json' }],
  ['013', { migration: '013_verifier_cursors', verifier: 'verify-migration-013-verifier-cursors.mjs', script: 'backend:release:migration:013:check', isolatedStep: 'Verify migration-013 verifier cursor contract', restoredStep: 'Verify restored migration-013 verifier cursor contract', artifact: 'restored-migration-013-verifier-cursors.json' }],
  ['014', { migration: '014_webhook_replay_claims', verifier: 'verify-migration-014-webhook-replay-claims.mjs', script: 'backend:release:migration:014:check', isolatedStep: 'Verify migration-014 webhook replay claim contract', restoredStep: 'Verify restored migration-014 webhook replay claim contract', artifact: 'restored-migration-014-webhook-replay-claims.json' }],
  ['015', { migration: '015_verified_trust_signals', verifier: 'verify-migration-015-trust-signals.mjs', script: 'backend:release:migration:015:check', isolatedStep: 'Verify migration-015 trust-signal constraints', restoredStep: 'Verify restored migration-015 trust-signal constraints', artifact: 'restored-migration-015-trust-signals.json' }],
  ['016', { migration: '016_webhook_inbox', verifier: 'verify-migration-016-webhook-inbox.mjs', script: 'backend:release:migration:016:check', isolatedStep: 'Verify migration-016 webhook inbox race', restoredStep: 'Verify restored migration-016 webhook inbox race', artifact: 'restored-migration-016-webhook-inbox.json' }],
  ['017', { migration: '017_extension_hooks', verifier: 'verify-migration-017-extension-hooks.mjs', script: 'backend:release:migration:017:check', isolatedStep: 'Verify migration-017 extension-hook constraints', restoredStep: 'Verify restored migration-017 extension-hook constraints', artifact: 'restored-migration-017-extension-hooks.json' }],
  ['018', { migration: '018_operations_quality_runs', verifier: 'verify-migration-018-constraints.mjs', script: 'backend:release:migration:018:check', isolatedStep: 'Verify migration-018 operations-quality constraints', restoredStep: 'Verify restored migration-018 operations-quality constraints', artifact: 'restored-migration-018-constraints.json' }],
  ['019', { migration: '019_reviewer_attestations', verifier: 'verify-migration-019-constraints.mjs', script: 'backend:release:migration:019:check', isolatedStep: 'Verify migration-019 SQL constraints', restoredStep: 'Verify restored migration-019 SQL constraints', artifact: 'restored-migration-019-constraints.json' }],
  ['020', { migration: '020_outbox_lease_state', verifier: 'verify-migration-020-outbox-leases.mjs', script: 'backend:release:migration:020:check', isolatedStep: 'Verify migration-020 outbox lease state', restoredStep: 'Verify restored migration-020 outbox lease state', artifact: 'restored-migration-020-outbox-leases.json' }]
])

function json(value) { return JSON.stringify(value, null, 2) }

async function collectCoverage() {
  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort()
  assert.deepEqual(migrationFiles.map((name) => name.slice(0, 3)), [...EXPECTED.keys()], 'migration SQL inventory must be exactly 001..020')

  const packageJson = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'))
  const workflow = await readFile(WORKFLOW, 'utf8')
  const recoveryVerifier = await readFile(RECOVERY_VERIFIER, 'utf8')
  const rows = []
  for (const [number, contract] of EXPECTED) {
    const verifierPath = path.join(__dirname, contract.verifier)
    await readFile(verifierPath, 'utf8')
    assert.equal(typeof packageJson.scripts?.[contract.script], 'string', `${contract.script} is missing`)
    assert.match(workflow, new RegExp(contract.isolatedStep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${contract.isolatedStep} is missing from CI`)
    assert.match(workflow, new RegExp(contract.restoredStep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${contract.restoredStep} is missing from recovery CI`)
    assert.match(recoveryVerifier, new RegExp(contract.artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${contract.artifact} is missing from recovery allowlist/classifier`)
    rows.push({ number, migration: contract.migration, verifier: contract.verifier, packageScript: contract.script, isolatedCi: true, restoredCi: true, recoveryArtifact: contract.artifact })
  }
  assert.doesNotMatch(workflow, /migration-021|migration-022|restored-migration-021|restored-migration-022/i, 'CI must not fabricate migration-021/022 coverage')
  assert.doesNotMatch(recoveryVerifier, /migration-021|migration-022|restored-migration-021|restored-migration-022/i, 'recovery verifier must not fabricate migration-021/022 coverage')
  return { status: 'verified', migrationCount: rows.length, migrations: rows, futureBoundary: { '021': 'not_present', '022': 'not_present' }, coverageContract: 'sql-verifier-package-ci-recovery', authority: 'coverage_audit_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_COVERAGE_AUDIT_ISOLATED=true is required', authority: 'coverage_audit_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
    process.exitCode = 1
    return
  }
  try {
    console.log(json(await collectCoverage()))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, authority: 'coverage_audit_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
    process.exitCode = 1
  }
}

await main()
