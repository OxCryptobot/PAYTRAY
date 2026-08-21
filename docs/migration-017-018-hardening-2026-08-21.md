# PayTray Migration-017/018 Hardening

## Scope and safety boundary

This batch hardens extension-hook lifecycle verification and operations-quality evidence persistence. It does not alter payment settlement, ledger authority, AI ranking promotion, release eligibility, target configuration, human review state, or chain transactions.

All runtime evidence uses local disposable PostgreSQL fixtures and retains:

```json
{
  "databaseIsolation": true,
  "cleanupPerformed": true,
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false
}
```

## Migration-015/016 CI review

The successful CI baseline was run 32449191334 for commit `b9dc3017eab349b0649ec6562013ebc096400daf`. The isolated PostgreSQL route-contract job initialized PostgreSQL 16 on `127.0.0.1`, applied migrations, executed migration-015 and migration-016 verifiers with bounded 8-attempt/3-repetition settings, and retained the normal contract artifacts. The restored recovery job performed a disposable backup/restore, repeated both verifiers against the restored database, prepared recovery SHA-256 sidecars, verified the allowlisted recovery bundle, and uploaded redacted evidence.

PostgreSQL `ERROR` lines in the logs were expected duplicate-path evidence from migration-015 uniqueness races. They were not process failures: the jobs concluded successfully, the verifiers classified the SQLSTATE as `23505`, and all eight workflow jobs passed. This confirms the established CI taxonomy: raw database error text is insufficient to identify an actual job failure.

## Migration-017 extension-hook hardening

The verifier preserves its catalog, v2/default, API-version (`23514`), replay-window (`23514`), and required-owner (`23502`) assertions. The deactivation race now accepts bounded `MIGRATION_017_CONCURRENCY_ATTEMPTS=2..16` and `MIGRATION_017_CONCURRENCY_REPETITIONS=1..10`, uses the real owner-bound update predicate, and requires exactly one winner, attempts-minus-one losers, and zero remaining active rows per repetition.

The local validation run used 8 attempts × 5 repetitions: 40 total updates, 5 winners, 35 losers, zero active rows after each race, and complete cleanup. Per-race elapsed milliseconds are reported as diagnostic telemetry only.

## Migration-018 operations-quality hardening

The duplicate-run race remains bounded by `MIGRATION_018_CONCURRENCY_ATTEMPTS=2..16` and `MIGRATION_018_CONCURRENCY_REPETITIONS=1..10`. After each race, the verifier now reads the persisted row and asserts strict mode, status, all report counters, canonical report hash, and every immutable safety field: `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `deploymentPerformed=false`, and `settlementMutationPerformed=false`.

The local validation run used 8 attempts × 5 repetitions: 40 total inserts, 5 committed winners, 35 SQLSTATE `23505` duplicate rejects, zero unexpected rejects, one persisted row per run ID, and complete cleanup. Report-hash and persisted-safety assertions passed for every winner.

## CI and reusable skill

The isolated and restored workflow paths now pass migration-017 concurrency bounds while preserving existing migration-018 bounds. The reusable skill adds `migration-017-018-contracts.md`, updated progressive-disclosure navigation, and the hardened verifier procedures. Timing data remains engineering diagnostics and cannot clear RTO, target, release, human, or settlement gates.

## Interpretation

Migration-017 evidence proves only bounded owner-scoped deactivation idempotency. Migration-018 evidence proves only bounded duplicate-run persistence and immutable operations-quality safety fields. Neither proves webhook delivery, chain truth, payment settlement, AI promotion, target readiness, release authority, or production capacity.
