import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateRecoveryArtifactBundle } from '../scripts/verify-recovery-artifact.mjs'

function recoveryArtifact(timing) {
  return {
    reportKind: 'recovery_evidence',
    status: 'verified',
    sourceDatabase: 'postgresql://127.0.0.1/paytray_ci',
    backup: {
      path: '/tmp/paytray-recovery.dump',
      bytes: 100,
      sha256: 'a'.repeat(64),
      catalogEntries: 10,
      format: 'custom',
      ownerAndPrivilegesExcluded: true
    },
    restore: {
      status: 'verified',
      tableCount: 37,
      migrationCount: 20,
      database: 'postgresql://127.0.0.1/paytray_recovery_ci'
    },
    authority: 'recovery_evidence_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'isolated_recovery_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    timing
  }
}

describe('recovery artifact timing contract', () => {
  it('accepts measured timing with an internally consistent operator RTO target', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-timing-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { backup: { status: 'ok', durationMs: 1200 }, restore: { status: 'ok', durationMs: 800 } },
        rto: { targetMs: 5000, targetConfigured: true, withinTarget: true, basis: 'operator_supplied' }
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing).toEqual({
        elapsedMs: 2000,
        phaseCount: 2,
        targetConfigured: true,
        withinTarget: true
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an RTO result that contradicts elapsed time', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-timing-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:06.000Z',
        elapsedMs: 6000,
        phases: { restore: { status: 'ok', durationMs: 6000 } },
        rto: { targetMs: 5000, targetConfigured: true, withinTarget: true, basis: 'operator_supplied' }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('withinTarget is inconsistent')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration coverage report', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-coverage-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-coverage.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migrationCount: 20,
        futureBoundary: { '021': 'not_present', '022': 'not_present' },
        authority: 'coverage_audit_only',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-coverage.json']).toMatchObject({ status: 'verified', migrationCount: 20, authority: 'coverage_audit_only' })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-001 bootstrap contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-001-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-001-bootstrap.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '001_init',
        cases: {
          catalog: { status: 'passed' },
          duplicateWallet: { status: 'passed', sqlState: '23505' },
          duplicateMigrationName: { status: 'passed', sqlState: '23505' },
          missingProfileUser: { status: 'passed', sqlState: '23503' },
          missingStreamSender: { status: 'passed', sqlState: '23503' },
          missingStreamRecipient: { status: 'passed', sqlState: '23503' },
          missingCallInitiator: { status: 'passed', sqlState: '23503' },
          missingCallRecipient: { status: 'passed', sqlState: '23503' },
          missingConnectionUser: { status: 'passed', sqlState: '23503' },
          nullWalletAddress: { status: 'passed', sqlState: '23502' },
          nullProfileUser: { status: 'passed', sqlState: '23502' },
          nullStreamAssetSymbol: { status: 'passed', sqlState: '23502' },
          nullConnectionWallet: { status: 'passed', sqlState: '23502' },
          cascadeDelete: { status: 'passed' },
          schemaMigrationIdempotencyRace: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 }
        },
        cleanupRows: { verifierUsers: 'all prefixed users', schemaMigrations: 'all prefixed records' },
        databaseIsolation: true,
        cleanupPerformed: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-001-bootstrap.json']).toMatchObject({ status: 'verified', migration: '001_init', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-003 discovery-v1 contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-003-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-003-discovery-v1.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '003_discovery_v1',
        cases: {
          catalog: { status: 'passed' },
          defaults: { status: 'passed' },
          roundTrip: { status: 'passed' },
          nullAvailability: { status: 'passed', sqlState: '23502' },
          nullLanguages: { status: 'passed', sqlState: '23502' },
          nullVerification: { status: 'passed', sqlState: '23502' },
          nullEvidenceLinks: { status: 'passed', sqlState: '23502' },
          nullCompletionRate: { status: 'passed', sqlState: '23502' },
          nullRepeatBookingRate: { status: 'passed', sqlState: '23502' },
          nullPaidMinutes: { status: 'passed', sqlState: '23502' },
          nullDisputesCount: { status: 'passed', sqlState: '23502' },
          concurrencyBoundary: { status: 'not_applicable' }
        },
        cleanupRows: { profiles: 'all profiles for verifier users', users: 'all verifier users' },
        databaseIsolation: true,
        cleanupPerformed: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-003-discovery-v1.json']).toMatchObject({ status: 'verified', migration: '003_discovery_v1', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-002 financial-core contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-002-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-002-financial-core.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '002_financial_core',
        cases: {
          catalog: { status: 'passed' },
          duplicateSenderIdempotency: { status: 'passed', sqlState: '23505' },
          duplicateTransactionHash: { status: 'passed', sqlState: '23505' },
          invalidDecimals: { status: 'passed', sqlState: '23514' },
          duplicateChainIdentity: { status: 'passed', sqlState: '23505' },
          missingLedgerProvenance: { status: 'passed', sqlState: '23514' },
          concurrentPaymentIntentIdempotency: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 },
          concurrentChainEventIdentity: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 },
          concurrentLedgerEventType: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 },
          concurrentIdempotencyRecord: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 }
        },
        cleanupRows: { users: 2, engagements: 1, streams: 1, intents: 3, chainEvents: 3, accounts: 2, ledgerEntries: 'all fixture entries', idempotencyRecords: 'all verifier-scope records', outboxEvents: 1, auditEvents: 1 },
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-002-financial-core.json']).toMatchObject({ status: 'verified', migration: '002_financial_core', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-004 engagement-context contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-004-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-004-engagement-context.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '004_engagement_context',
        cases: {
          catalog: { status: 'passed' },
          defaults: { status: 'passed' },
          roundTrip: { status: 'passed' },
          invalidCollaboration: { status: 'passed', sqlState: '23514' },
          invalidPayment: { status: 'passed', sqlState: '23514' },
          nullCollaboration: { status: 'passed', sqlState: '23502' },
          nullPayment: { status: 'passed', sqlState: '23502' },
          concurrentOptimisticContextUpdate: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 }
        },
        cleanupRows: { users: 2, engagements: 1 },
        databaseIsolation: true,
        cleanupPerformed: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-004-engagement-context.json']).toMatchObject({ status: 'verified', migration: '004_engagement_context', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-005 outcome-lineage contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-005-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-005-outcome-lineage.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '005_outcomes_and_metrics',
        cases: {
          catalog: { status: 'passed' },
          validRoundTrip: { status: 'passed' },
          duplicateIdentity: { status: 'passed', sqlState: '23505' },
          invalidEventType: { status: 'passed', sqlState: '23514' },
          invalidActorType: { status: 'passed', sqlState: '23514' },
          invalidReviewState: { status: 'passed', sqlState: '23514' },
          missingEngagement: { status: 'passed', sqlState: '23503' },
          nullOccurredAt: { status: 'passed', sqlState: '23502' },
          concurrentDuplicateIdentity: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 },
          concurrentVerifierTransition: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12 }
        },
        cleanupRows: { users: 2, engagements: 1, outcomeEvents: 'all events for verifier engagements' },
        databaseIsolation: true,
        cleanupPerformed: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-005-outcome-lineage.json']).toMatchObject({ status: 'verified', migration: '005_outcomes_and_metrics', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-006 AI evaluation foundation contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-006-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-006-ai-evaluation-foundation.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '006_ai_evaluation_foundation',
        cases: { catalog: { status: 'passed' }, invalidConfidence: { status: 'passed', sqlState: '23514' }, appliedWithoutHumanReview: { status: 'passed', sqlState: '23514' }, concurrentDuplicateEvaluationExample: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12, validRuns: 3 } },
        cleanupRows: { examples: 4, snapshots: 1, evaluationRuns: 1, profiles: 1, users: 2 },
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-006-ai-evaluation-foundation.json']).toMatchObject({ status: 'verified', migration: '006_ai_evaluation_foundation', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-007 discovery-impressions contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-007-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-007-discovery-impressions.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '007_discovery_impressions',
        cases: { catalog: { status: 'passed' }, duplicateQueryCandidate: { status: 'passed', sqlState: '23505' }, invalidRank: { status: 'passed', sqlState: '23514' }, invalidScore: { status: 'passed', sqlState: '23514' }, concurrentDuplicateQueryCandidate: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12, validRuns: 3 } },
        cleanupRows: { impressions: 4, profiles: 4, users: 8 },
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-007-discovery-impressions.json']).toMatchObject({ status: 'verified', migration: '007_discovery_impressions', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-008 production-telemetry contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-008-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-008-production-telemetry.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '008_production_telemetry',
        cases: { catalog: { status: 'passed' }, duplicateEventId: { status: 'passed', sqlState: '23505' }, invalidEventType: { status: 'passed', sqlState: '23514' }, invalidPrivacyClass: { status: 'passed', sqlState: '23514' }, concurrentDuplicateEventId: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12, validRuns: 3 } },
        cleanupEventIds: 4,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-008-production-telemetry.json']).toMatchObject({ status: 'verified', migration: '008_production_telemetry', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-009 verified-outcome provenance contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-009-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-009-verified-outcome-provenance.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '009_verified_outcome_provenance',
        cases: { catalog: { status: 'passed' }, defaultValues: { status: 'passed' }, roundTrip: { status: 'passed', persisted: true }, invalidStatus: { status: 'passed', sqlState: '23514' }, oversizedHash: { status: 'passed', sqlState: '22001' } },
        cleanupRows: { outcomes: 1, engagements: 1, users: 2 },
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-009-verified-outcome-provenance.json']).toMatchObject({ status: 'verified', migration: '009_verified_outcome_provenance', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-010 ledger intent idempotency contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-010-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-010-ledger-intent-idempotency.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '010_ledger_intent_idempotency',
        cases: { catalog: { status: 'passed' }, duplicateIntentEntry: { status: 'passed', sqlState: '23505' }, distinctEntryType: { status: 'passed' }, missingProvenance: { status: 'passed', sqlState: '23514' }, concurrentDuplicateIntentEntry: { status: 'verified', attempts: 4, repetitions: 3, totalAttempts: 12, validRuns: 3 } },
        cleanupRows: { intents: 4, accounts: 8, users: 8 },
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-010-ledger-intent-idempotency.json']).toMatchObject({ status: 'verified', migration: '010_ledger_intent_idempotency', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-017 extension-hook contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-017-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-017-extension-hooks.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '017_extension_hooks',
        databaseIsolation: true,
        cases: { catalog: { status: 'passed' }, deactivationRace: { status: 'passed', winners: 1, losers: 1 } },
        cleanupHooks: 6,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-017-extension-hooks.json']).toMatchObject({ status: 'verified', migration: '017_extension_hooks', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-011 payment provenance contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-011-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-011-payment-provenance.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '011_payment_stream_verifier_provenance',
        cases: { catalog: { status: 'passed' }, nullProvenance: { status: 'passed', sqlState: '23502' }, roundTrip: { status: 'passed', roundTripMatches: true } },
        cleanupUsers: 2,
        cleanupStreams: 1,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-011-payment-provenance.json']).toMatchObject({ status: 'verified', migration: '011_payment_stream_verifier_provenance', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-012 shadow-run review contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-012-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-012-shadow-run-review.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '012_shadow_run_review',
        cases: { catalog: { status: 'passed' }, reviewRace: { status: 'verified', attempts: 2, winners: 1, conflicts: 1, rollbacks: 1, applied: false, promotionStatus: 'shadow_only' } },
        cleanupRunId: '11111111-1111-4111-8111-111111111111',
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-012-shadow-run-review.json']).toMatchObject({ status: 'verified', migration: '012_shadow_run_review', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-013 verifier cursor contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-013-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-013-verifier-cursors.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '013_verifier_cursors',
        cases: { catalog: { status: 'passed' }, negativeBlock: { status: 'passed', sqlState: '23514' }, nullBlock: { status: 'passed', sqlState: '23502' }, duplicateChain: { status: 'passed', sqlState: '23505' } },
        cleanupChainIds: 4,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-013-verifier-cursors.json']).toMatchObject({ status: 'verified', migration: '013_verifier_cursors', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-014 webhook replay claim contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-014-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-014-webhook-replay-claims.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '014_webhook_replay_claims',
        cases: { catalog: { status: 'passed' }, nullReplayKey: { status: 'passed', sqlState: '23502' }, duplicateReplayKey: { status: 'passed', sqlState: '23505' }, expiredReplacement: { status: 'passed', replaced: true }, concurrentClaim: { status: 'passed', attempts: 2, winners: 1, losers: 1 } },
        cleanupKeys: 4,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-014-webhook-replay-claims.json']).toMatchObject({ status: 'verified', migration: '014_webhook_replay_claims', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-015 trust-signal contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-015-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-015-trust-signals.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '015_verified_trust_signals',
        cases: {
          catalog: { status: 'passed' },
          validSignal: { status: 'passed', eligibleForRanking: false },
          foreignKeys: { status: 'passed', sqlStates: ['23503'] },
          polarity: { status: 'passed', sqlState: '23514' },
          score: { status: 'passed', sqlState: '23514' },
          rankingEligibility: { status: 'passed', sqlState: '23514' },
          uniqueness: { status: 'passed', sqlState: '23505' },
          concurrentUniqueness: { status: 'verified', attempts: 2, repetitions: 1, validRuns: 1 }
        },
        cleanupPerformed: true,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-015-trust-signals.json']).toMatchObject({ status: 'verified', migration: '015_verified_trust_signals', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-016 webhook-inbox contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-016-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-016-webhook-inbox.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '016_webhook_inbox',
        runs: [{
          status: 'passed',
          firstClaim: { attempts: 2, winners: 1, losers: 1 },
          reclaim: { attempts: 2, winners: 1, losers: 1 },
          conflictRejected: true,
          processedDuplicate: { claimed: false, duplicate: true, reason: 'processed', mutation: 'read_only' },
          finalState: { status: 'claimed', attempts: 2, payloadApplied: false }
        }],
        concurrency: { attempts: 2, repetitions: 1, totalAttempts: 2, validRuns: 1 },
        cleanupPerformed: true,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-016-webhook-inbox.json']).toMatchObject({ status: 'verified', migration: '016_webhook_inbox', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-018 concurrency contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-018-concurrency-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-018-concurrency.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '018_operations_quality_runs',
        concurrency: { attempts: 8, repetitions: 3, totalAttempts: 24, validRuns: 3 },
        runs: [],
        cleanupRuns: 3,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        valid: true
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-018-concurrency.json']).toMatchObject({ status: 'verified', migration: '018_operations_quality_runs', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})


describe('recovery artifact resource telemetry contract', () => {
  const resourceSample = {
    basis: 'node_process_resource_usage',
    rssBytes: 1000,
    rssDeltaBytes: 100,
    heapUsedBytes: 500,
    externalBytes: 50,
    arrayBuffersBytes: 20,
    peakRssKb: 200,
    userCpuTimeUs: 30,
    systemCpuTimeUs: 10,
    fsReadOps: 2,
    fsWriteOps: 3,
    voluntaryContextSwitches: 1,
    involuntaryContextSwitches: 0
  }

  const databaseTelemetry = {
    basis: 'postgresql_observability',
    sampleCount: 2,
    connectionAcquisitionMs: { count: 2, p50: 2, p95: 3, p99: 3, max: 3, mean: 2.5 },
    waitEvents: {
      sampleCount: 2,
      observations: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', observations: 2, observedBackendCount: 3 }]
    },
    databaseStats: {
      before: { databaseSizeBytes: 100, tempBytes: 10, tempFiles: 1, blocksRead: 2, blocksHit: 3 },
      after: { databaseSizeBytes: 120, tempBytes: 110, tempFiles: 3, blocksRead: 7, blocksHit: 9 },
      deltas: { databaseSizeBytes: 20, tempBytes: 100, tempFiles: 2, blocksRead: 5, blocksHit: 6 }
    },
    temporaryStorage: { tempBytesDelta: 100, tempFilesDelta: 2, throughputBytesPerSecond: 1000, operationElapsedMs: 100 },
    errors: []
  }

  const storageTelemetry = {
    basis: 'local_disposable_backup_file',
    backupBytes: 1000,
    backupDurationMs: 20,
    backupWriteThroughputBytesPerSecond: 50000
  }

  it('accepts process and phase resource telemetry', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-resource-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        resource: {
          basis: 'node_process_resource_usage',
          process: resourceSample,
          phases: { restore: resourceSample }
        }
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.resource.phases.restore.fieldCount).toBe(12)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts PostgreSQL and backup-storage telemetry with bounded fields', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-database-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        database: databaseTelemetry,
        storage: storageTelemetry
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.database).toMatchObject({ basis: 'postgresql_observability', waitEventCount: 1 })
      expect(result.artifacts['recovery-evidence.json'].timing.storage.backupBytes).toBe(1000)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a database telemetry observation with a negative count', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-database-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        database: {
          ...databaseTelemetry,
          waitEvents: {
            ...databaseTelemetry.waitEvents,
            observations: [{ ...databaseTelemetry.waitEvents.observations[0], observedBackendCount: -1 }]
          }
        }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('observedBackendCount must be a nonnegative integer')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a resource sample with a negative metric', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-resource-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        resource: {
          basis: 'node_process_resource_usage',
          process: { ...resourceSample, rssBytes: -1 },
          phases: { restore: resourceSample }
        }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('rssBytes must be a nonnegative integer')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})


describe('recovery artifact child-process telemetry contract', () => {
  const timingWithChild = (overrides = {}) => ({
    startedAt: '2026-08-18T23:00:00.000Z',
    completedAt: '2026-08-18T23:00:02.000Z',
    elapsedMs: 2000,
    phases: { restore: { status: 'ok', durationMs: 2000 } },
    rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
    childProcesses: {
      restore: {
        basis: 'procfs_child_process',
        clockTickHz: 100,
        elapsedMs: 400.25,
        userCpuTimeMs: 30.5,
        systemCpuTimeMs: 4.25,
        peakRssKb: 12000,
        exitCode: 0,
        signal: null,
        ...overrides
      }
    }
  })

  it('accepts a successful procfs restore child report', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-child-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact(timingWithChild())))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.childProcesses.restore).toMatchObject({
        basis: 'procfs_child_process',
        elapsedMs: 400.25,
        peakRssKb: 12000
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a child report with a nonzero exit code', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-child-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact(timingWithChild({ exitCode: 1 }))))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('must have a successful process exit')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
