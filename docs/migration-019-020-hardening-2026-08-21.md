# PayTray Migration-019/020 Hardening

## Scope and safety boundary

This batch hardens reviewer-attestation transaction races and durable outbox lease-state completion. It does not submit human decisions, create genuine reviewer evidence, mutate payment or ledger state, promote AI ranking, change target configuration, or grant release authority.

All verifier reports are local disposable PostgreSQL evidence and retain `databaseIsolation=true`, `cleanupPerformed=true`, `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `deploymentPerformed=false`, and `settlementMutationPerformed=false`.

## Migration-017/018 audit findings

The audited migration-017 negative paths were invalid API version (`23514`), replay-window lower and upper bounds (`23514`), and null owner (`23502`). Its increased-load run used 8 attempts × 5 repetitions, yielding one deactivation winner, seven losers, zero active rows, and no unexpected process failure per repetition.

The audited migration-018 path used deliberate duplicate `operations_quality_runs` inserts. All losing inserts returned SQLSTATE `23505` against the unique `run_id` constraint. The persisted winner checks matched the canonical report hash and immutable safety fields. These PostgreSQL `ERROR` lines were expected negative-path evidence; the CI job remained successful. Raw `ERROR` count was not used as a failure criterion.

## Migration-019 reviewer-attestation hardening

The verifier now accepts `ATTESTATION_RACE_ATTEMPTS=2..8` and `ATTESTATION_RACE_REPETITIONS=1..10`, expands each race to multiple concurrent verification transactions, requires exactly one verified attestation, requires attempts-minus-one rejected transactions, and requires rollback confirmation for every loser. It continues to verify one consumed challenge, one attestation, one financial-audit event, exact message reconstruction, and immutable false/read-only authority fields.

The local disposable run used 4 attempts × 5 repetitions: 20 total verification attempts, 5 winners, 15 expected consumed-challenge rejections, 15 confirmed rollbacks, one attestation per repetition, one audit event per repetition, and complete cleanup. Per-repetition elapsed milliseconds are reported as diagnostic engineering telemetry only. No output is a human decision or genuine release attestation.

## Migration-020 outbox lease hardening

The verifier now accepts `MIGRATION_020_RACE_ATTEMPTS=2..8` and `MIGRATION_020_RACE_REPETITIONS=1..10`, repeats the `FOR UPDATE SKIP LOCKED` claim race, requires one winner and attempts-minus-one null losers, and verifies the winner increments attempts exactly once with a UUID lease token.

A stale random lease token must update zero rows. The current lease token must complete exactly one row. The persisted row must then have `processed_at` present, `lease_token`, `lease_acquired_at`, and `lease_expires_at` cleared, `attempts=1`, `last_attempt_at` present, and `dead_lettered_at` null. The final local run used 8 attempts × 5 repetitions: 40 claims, 5 winners, 35 losers, 5 stale-token rejections, 5 current-token completions, and complete cleanup. Timing was 1–10 ms per race, mean 3.4 ms, p95 10 ms.

The first migration-020 validation exposed a real verifier/schema mismatch: the verifier attempted to update a nonexistent `outbox_events.updated_at` column. The verifier was corrected to use only the actual lease and processed fields; the rerun passed. This was a verifier defect, not evidence of a database contract failure.

## CI and reusable skill

The isolated and restored CI jobs now receive bounded migration-019 and migration-020 parameters. Recovery artifacts remain allowlisted, hashed, bundle-verified, and uploaded redacted. The reusable skill includes `migration-019-020-contracts.md`, updated step 31, progressive-disclosure navigation, and both hardened verifiers.

## Interpretation

Migration-019 proves only disposable transaction race and rollback behavior. Migration-020 proves only lease claim, stale-token protection, and token-matched completion behavior. Neither establishes human approval, signature custody, target readiness, payment settlement, chain truth, release eligibility, or production capacity.
