# Recovery Artifact Verification and Migration-Skill Reuse Review

## Executive assessment

The PayTray recovery job performs strong **execution-time verification** and safe artifact retention, but its final recovery artifact step is currently a **fingerprint-and-upload contract**, not a second content-schema verification layer. The recovery verifier itself validates the restored database, expected table inventory, migration count, isolated target, backup catalog, and redacted safety metadata before emitting JSON. GitHub Actions then preserves the command status, fingerprints the JSON files with SHA-256, and uploads them with a seven-day retention policy.[1] [2]

The reusable `paytray-postgres-release-verification` skill generalizes well to other migration versions when its common disposable-database harness is combined with migration-specific contract adapters. Migration 019 is the richest current example because it combines checks, foreign keys, uniqueness, immutable authority fields, metadata mirroring, and a live concurrency race. Migrations 018, 016, 015, 017, 014, 013, 010, and 012 can use the same isolation, fixture, SQLSTATE, cleanup, redaction, and CI-artifact patterns with different schema assertions.[3] [4] [5]

## 1. Recovery job artifact flow

The `recovery-contract` job runs on an Ubuntu runner with a disposable PostgreSQL 16 service named `paytray_ci`. It initializes the source schema, creates a distinct `paytray_recovery_ci` database, runs `pg_dump`/`pg_restore` through `backend:recovery:check`, and verifies restored migrations and ready-PostgreSQL route contracts against the restored URL.[1]

| Stage | Workflow behavior | Safety effect |
|---|---|---|
| Source setup | Runs `backend:migrations:check` against `paytray_ci`. | Establishes the source schema before backup. |
| Restore isolation | Creates `paytray_recovery_ci` and requires `RECOVERY_RESTORE_DATABASE_URL` to differ from `DATABASE_URL`. | Prevents restore into the source target. |
| Backup/restore evidence | Redirects `backend:recovery:check` output to `artifacts/recovery-evidence.json`, prints it, and returns its original exit status. | Preserves a redacted report while keeping failure fatal. |
| Restored schema | Writes `restored-migrations.json` and `restored-ready-postgres.json`. | Proves migration and route contracts on the restored database. |
| Migration-019 checks | Runs the disposable SQL constraint verifier with `MIGRATION_019_CONTRACT_ISOLATED=true`. | Rechecks database constraints after restore. |
| Attestation race | Runs the two-transaction race verifier with `ATTESTATION_RACE_ISOLATED=true`. | Rechecks concurrent one-time attestation behavior after restore. |
| Evidence fingerprint | Runs `sha256sum` over all five JSON reports and writes `recovery-evidence.sha256`. | Detects later artifact replacement or alteration. |
| Upload | Uploads the five JSON reports and sidecar hash with `if: always()` and seven-day retention. | Retains redacted evidence even after a failed verification step. |

The source migration and ready-route steps are ordinary fatal steps. The newly added restored migration-019 and race steps use `if: always()` so they still execute and produce reports after an earlier failure. Their shell bodies use `set +e`, capture `$?`, print the report, and `exit $status`. This is the correct fail-closed pattern: **artifact capture continues, but a failed check still fails the job**.[1]

## 2. What the recovery verifier validates

`verify-recovery-evidence.mjs` is the first content verifier in the recovery chain. It requires `DATABASE_URL`, `RECOVERY_BACKUP_FILE`, and, when restore is requested, a distinct `RECOVERY_RESTORE_DATABASE_URL` plus `RECOVERY_TARGET_ISOLATED=true`. It invokes `pg_dump` in custom format without owner or privilege data, fingerprints the dump, inspects the `pg_restore --list` catalog, restores into the isolated target, and checks the restored schema.[2]

The restored schema check requires all expected tables, including `reviewer_attestation_challenges` and `reviewer_attestations`, and exactly **19 migration records**. The emitted report contains a safe database label, backup byte count, backup SHA-256, catalog-entry count, format, restore status, `authority: 'recovery_evidence_only'`, and non-authority execution flags. It does not expose database credentials or raw application data.[2]

The recovery verifier uses a safe status model:

| Report condition | Status | Exit behavior |
|---|---|---:|
| Restore completed and schema verified | `verified` | Exit `0`. |
| Backup/catalog exists but restore was not requested | `schema_catalog_only` | Exit `1`, because the full recovery contract was not completed. |
| Any required environment, dump, restore, or schema check fails | `blocked` | Exit `1`. |

## 3. How redacted JSON is verified in GitHub Actions

There are two distinct verification layers.

### Layer A: producer-side semantic verification

Each command that produces a report performs its own semantic checks and exits nonzero on failure. The recovery verifier checks backup/restore semantics. The migration-019 verifier checks SQLSTATE and catalog contracts. The attestation-race verifier checks two-transaction outcomes, row counts, audit counts, and immutable fields. The migration and route verifiers check their own schema or route contracts.[1] [2]

### Layer B: artifact preservation and integrity fingerprinting

GitHub Actions redirects stdout to JSON files, prints each report, fingerprints the files with `sha256sum`, and uploads them. The sidecar hash proves that the uploaded file matches the file present at the fingerprint step, but it does **not** independently validate JSON schema, safety fields, report status, or content semantics after generation.[1]

The repository has a stronger redacted-content verifier named `verify-ci-matrix-artifact.mjs`, but the current workflow uses it for `artifacts/operations-quality.json` and `artifacts/release-gates.json`, not for the recovery JSON bundle. That verifier parses JSON, rejects sensitive keys recursively, validates report kind and safe status, reconciles check counts, requires named checks such as `secret-manager-custody`, and enforces false/read-only safety fields.[6]

Therefore, the current recovery path is:

> **Command semantic verification → redacted JSON capture → SHA-256 fingerprint → artifact upload.**

It is not yet:

> **Command semantic verification → recovery-report schema verification → redacted JSON capture → SHA-256 fingerprint → artifact upload.**

A future hardening batch could add a dedicated `verify-recovery-artifact.mjs` that parses each recovery report, rejects sensitive keys, validates the allowed report kinds and safety fields, confirms expected statuses, validates the hash sidecar, and runs before upload. This would complement—not replace—the producer-side checks.

## 4. Applying the reusable skill to other migration versions

The reusable skill’s invariant workflow is migration-agnostic:

1. Require a local/test/disposable database URL and an explicit isolation flag.
2. Run or verify migrations against the disposable target.
3. Inspect catalog objects through `information_schema`, `pg_indexes`, and `pg_constraint` metadata.
4. Insert uniquely namespaced fixtures.
5. Assert exact SQLSTATEs for invalid records and exact positive row shapes.
6. Exercise concurrency only with independent clients and disposable rows.
7. Clean up fixtures in `finally` blocks.
8. Emit redacted JSON with `releaseEligible=false`, `settlementAuthority=false`, `mutation='read_only'`, and false execution flags.
9. Capture and fingerprint reports in CI.
10. Interpret a pass as a contract result, never as human approval or release authorization.

The skill currently documents migration-019 examples explicitly, but its reusable unit is the harness and safety contract. Each other migration should add a small adapter specifying tables, catalog objects, fixtures, allowed states, business invariants, and concurrency behavior.

### Recommended migration adapters

| Migration | Contract family | Reusable checks to add |
|---|---|---|
| `018_operations_quality_runs` | Durable redacted report storage | Verify `run_id` uniqueness, nonnegative counts, status allowlist, count reconciliation, 64-hex `report_hash`, JSONB `releaseEligible=false`, `settlementAuthority=false`, `mutation='read_only'`, false execution flags, and created/status indexes. Insert one valid report and reject each invalid count/status/safety mutation. |
| `016_webhook_inbox` | Durable processing state machine | Verify `replay_key` primary key, required event/body fields, status allowlist, `attempts >= 1`, due-work partial index, and status index. Add a two-client claim/reclaim race using the webhook inbox service and assert one winner, bounded retry, and no settlement mutation. |
| `015_verified_trust_signals` | Foreign keys plus business invariants | Create disposable user, engagement, and verifier-owned outcome fixtures. Verify three foreign keys, polarity allowlist, nonnegative score, `eligible_for_ranking=false`, uniqueness on subject/outcome/signal type, and subject/outcome indexes. Reject unverified or ranking-eligible inserts. |
| `017_extension_hooks` | Versioned extension configuration | Verify `api_version='v2'`, replay window between 60 and 86,400 seconds, required event/owner fields, and event/owner indexes. Reject unsupported API versions and unsafe replay windows. |
| `014_webhook_replay_claims` | Replay-key uniqueness and expiry | Verify replay-key primary key, required expiry, expiry index, duplicate rejection, and a two-client claim race if the service uses durable claims. |
| `013_verifier_cursors` | Numeric cursor boundary | Verify chain ID primary key and `last_scanned_block >= 0`; reject negative cursors and duplicate chain rows. |
| `010_ledger_intent_idempotency` | Partial unique index | Verify `ledger_entries_intent_type_unique` exists and rejects duplicate non-null `(source_intent_id, entry_type)` pairs while allowing null-source rows as designed. |
| `012_shadow_run_review` | Review projection columns and index | Verify reviewer fields exist and the `(reviewer_decision, reviewed_at DESC)` index exists. Combine with the shadow-review service to test terminal-decision idempotency and `shadow_only` safety. |

### Adapter design

A future generalized runner could accept a declarative contract descriptor:

```js
{
  migration: '018_operations_quality_runs',
  isolationEnv: 'MIGRATION_018_CONTRACT_ISOLATED',
  tables: ['operations_quality_runs'],
  indexes: ['operations_quality_runs_created_index', 'operations_quality_runs_status_index'],
  fixtures: { valid: [...], invalid: [...] },
  expectedSqlStates: { duplicateRun: '23505', invalidReportSafety: '23514' },
  safety: {
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
```

The current migration-019 verifier is deliberately explicit rather than generic because its attestation metadata and role-bound constraints are security-sensitive. Genericizing the fixture runner should not genericize the safety assertions or the service-specific concurrency logic.

## 5. Recommended next hardening batch

The highest-value follow-up is to add recovery-report content verification. It should accept only an explicit allowlist of report shapes, recursively reject sensitive keys, validate recovery authority and safety fields, validate migration count 19 for the current schema, validate that the two new contract reports have `status: 'verified'`, and verify the SHA-256 sidecar against the files just produced.

After that, add migration-specific contract suites in this order:

1. Migration 018, because it persists CI/release evidence and directly benefits from redacted JSON safety checks.
2. Migration 016, because its processing state machine benefits from a real two-client claim/reclaim race.
3. Migration 015, because trust-signal eligibility must remain permanently false and verifier-owned.
4. Migrations 017, 014, 013, 010, and 012 as smaller catalog and boundary contracts.

No migration adapter should query or mutate the six pending shadow runs, alter reviewer decisions, create approvals, or change release authority.

## References

[1]: file:///home/ubuntu/projects/PAYTRAY/.github/workflows/paytray-quality.yml "PayTray GitHub Actions quality and recovery workflow"

[2]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/scripts/verify-recovery-evidence.mjs "Disposable backup and recovery evidence verifier"

[3]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/scripts/verify-migration-019-constraints.mjs "Migration 019 SQL constraint verifier"

[4]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/scripts/verify-reviewer-attestation-concurrency.mjs "Reviewer-attestation concurrency verifier"

[5]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/migrations/018_operations_quality_runs.sql "Migration 018 operations-quality report constraints"

[6]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/scripts/verify-ci-matrix-artifact.mjs "Redacted CI matrix artifact content verifier"

[7]: file:///home/ubuntu/projects/PAYTRAY/packages/backend/migrations/016_webhook_inbox.sql "Migration 016 webhook inbox state-machine constraints"

[8]: file:///home/ubuntu/skills/paytray-postgres-release-verification/SKILL.md "Reusable PayTray PostgreSQL release-verification skill"
