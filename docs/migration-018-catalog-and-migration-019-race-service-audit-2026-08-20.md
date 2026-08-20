# Migration-018 Catalog and Migration-019 Race-Service Audit

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**CI run reviewed:** [32404681551](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32404681551)  
**Structured audit:** [`migration-018-019-race-service-audit-32404681551.json`](./migration-018-019-race-service-audit-32404681551.json)

## Migration-018 catalog and SQLSTATE verification

The migration-018 integration verifier returned `status=verified` in both isolated route and restored recovery jobs. The catalog assertion confirmed the exact indexes `operations_quality_runs_created_index` and `operations_quality_runs_status_index`. The valid control report persisted a canonical SHA-256 hash and safe authority fields.

| Migration-018 assertion | Expected SQLSTATE | Result |
|---|---:|---|
| Invalid status allowlist | `23514` | Passed |
| Negative check count | `23514` | Passed |
| Count reconciliation | `23514` | Passed |
| `releaseEligible=true` rejected | `23514` | Passed |
| `settlementAuthority=true` rejected | `23514` | Passed |
| `deploymentPerformed=true` rejected | `23514` | Passed |
| `settlementMutationPerformed=true` rejected | `23514` | Passed |
| `mutation != read_only` rejected | `23514` | Passed |
| Invalid report hash format | `23514` | Passed |
| Duplicate `run_id` | `23505` | Passed |
| Fixture cleanup | 10 run IDs | Passed |

The raw focused CI log shows the exact command, `MIGRATION_018_CONTRACT_ISOLATED=true`, successful JSON output, catalog indexes, and SQLSTATE sequence. A raw PostgreSQL `ERROR` line is expected for each negative probe; the successful verifier result and job conclusion determine workflow status.

## Migration-019 race and rollback logic

The reviewer-attestation service locks the challenge row with `SELECT * FROM reviewer_attestation_challenges WHERE id = $1 FOR UPDATE`, rejects a consumed challenge, and performs an atomic `UPDATE ... SET consumed_at = CURRENT_TIMESTAMP ... WHERE consumed_at IS NULL RETURNING id`. If the update returns no row, the service raises `Reviewer attestation challenge was consumed concurrently`. The winning transaction inserts one attestation and one `financial_audit_events` row; the losing transaction rolls back.

The CI race report configured `ATTESTATION_RACE_REPETITIONS=3`. Each run reported one committed winner with `commitPerformed=true`, one rejected loser with `commitPerformed=false` and `rollbackPerformed=true`, one attestation row, one consumed challenge, and one audit event. The aggregate fields were `rollbackVerified=true` and `rollbackVerifiedCount=3`.

The local disposable integration suite repeated the same race five times and returned `rollbackVerifiedCount=5`, with no extra rows and cleanup complete.

| Race invariant | CI result | Local result |
|---|---:|---:|
| Exactly one winner per repetition | 3/3 | 5/5 |
| Exactly one rolled-back loser | 3/3 | 5/5 |
| Exactly one attestation row | 3/3 | 5/5 |
| Exactly one consumed challenge | 3/3 | 5/5 |
| Exactly one audit event | 3/3 | 5/5 |
| Fail-closed authority fields | Passed | Passed |

## Reusable skill extension

The skill now includes `scripts/audit-migration-integration-logs.mjs`. It verifies migration-018 and migration-019 reports, catalog/SQLSTATE outcomes, cleanup counts, CI execution markers, race repetition and rollback fields, and the service-layer row-lock/atomic-consumption/audit-write contract. The script returned `valid=true` with zero errors.

Its progressive-disclosure reference `migration-integration-log-audit.md` now explains when to load this workflow, how to classify CI logs by job and step, and why raw error text cannot be used as a failure conclusion. The skill remains read-only and fail-closed.

## Safety boundary

This audit is disposable engineering evidence. It does not constitute human reviewer approval, shadow-review resolution, Ed25519 custody, Railway target evidence, deployment authorization, release eligibility, or settlement authority. All output remains `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, and non-mutating.
