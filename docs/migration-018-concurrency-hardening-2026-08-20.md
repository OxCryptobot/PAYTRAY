# Migration-018 Increased-Concurrency Hardening

**Date:** 2026-08-20
**Repository:** `OxCryptobot/PAYTRAY`
**Branch:** `paytray/batch-delivery`
**Evidence boundary:** fresh local disposable PostgreSQL only

## Runtime contract

The new `verify-migration-018-concurrency.mjs` verifier exercises duplicate `run_id` insertion under bounded concurrent load. It requires `MIGRATION_018_CONCURRENCY_ISOLATED=true`, a localhost PostgreSQL URL whose database name is disposable/test/recovery-qualified, `MIGRATION_018_CONCURRENCY_ATTEMPTS` from 2 through 16, and `MIGRATION_018_CONCURRENCY_REPETITIONS` from 1 through 10.

A valid repetition requires exactly one committed winner, `attempts - 1` rejected duplicates with SQLSTATE `23505`, zero unexpected SQLSTATEs, exactly one persisted row, and cleanup. It reports timing only as engineering diagnostics and preserves all false/read-only authority fields.

## Local evidence

On a fresh disposable database, the verifier ran **5 repetitions × 8 concurrent attempts**:

| Metric | Result |
|---|---:|
| Repetitions | 5/5 |
| Attempts per repetition | 8 |
| Total attempts | 40 |
| Committed winners | 5 |
| Duplicate rejects | 35 |
| Unexpected rejects | 0 |
| Persisted rows per repetition | 1 |
| Cleanup runs | 5 |
| Database isolation | `true` |
| Overall | `valid=true` |

The observed duplicate messages were PostgreSQL unique-constraint violations on `operations_quality_runs_run_id_key`. No transaction performed deployment or settlement mutation.

## CI and reusable skill

The verifier is wired into both the isolated PostgreSQL route contract and restored recovery contract jobs. The restored artifact is included in the SHA-256 sidecar, recovery-artifact classifier, verification input, and uploaded evidence set. The focused recovery-artifact regression accepts the new filename and preserves the fail-closed rejection path for unknown filenames.

The reusable skill now includes the migration-018 verifier in `scripts/` and documents its bounded execution contract in `references/migration-concurrency-audit.md`. The skill remains a read-only engineering-evidence workflow.

## Interpretation

This batch demonstrates duplicate-write behavior for the covered migration-018 path under bounded local concurrency. It is not a proof of general database capacity, production SLO compliance, RTO clearance, deployment readiness, release eligibility, or settlement authority. It does not resolve the remaining human-review, target-evidence, operator-key-custody, or Railway blockers. No live funds, mainnet transactions, real user data, approvals, identities, or keys were fabricated or used.
