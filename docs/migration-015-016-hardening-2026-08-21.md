# PayTray Migration-015/016 Hardening

## Scope and safety boundary

This batch hardens the live disposable PostgreSQL verifiers for verifier-owned trust signals and the durable webhook inbox. It does not alter payment settlement, ledger authority, AI ranking promotion, release eligibility, target configuration, human review state, or chain transactions.

All verification uses local disposable PostgreSQL fixtures and retains:

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

## Migration-013/014 performance baseline reviewed

The prior migration-013 and migration-014 load reports used eight concurrent attempts across five repetitions. Both completed 40 total attempts with five winners, 35 expected losers, zero unexpected failures, and complete fixture cleanup. Migration-013 classified every loser as SQLSTATE `23505`; migration-014 returned one replay-claim winner and seven non-claiming losers per repetition.

The isolated PostgreSQL workflow runs migration verifiers against a GitHub Actions PostgreSQL 16 service on `127.0.0.1`. It initializes migrations before the restored recovery path, requires explicit isolated environment guards, and retains redacted reports through a SHA-256 sidecar, allowlisted recovery bundle verifier, and artifact upload. No target environment is used by this job.

## Migration-015 trust-signal hardening

The verifier continues to assert the three foreign keys, two indexes, positive/neutral polarity, nonnegative score, immutable `eligible_for_ranking=false`, verifier-only provenance, and unique `(subject_user_id, outcome_id, signal_type)` behavior. It explicitly checks invalid user, engagement, and outcome references (`23503`), invalid polarity and negative score (`23514`), ranking-promotion attempts (`23514`), and ordinary duplicate signals (`23505`).

The new bounded race uses `MIGRATION_015_CONCURRENCY_ATTEMPTS=2..16` and `MIGRATION_015_CONCURRENCY_REPETITIONS=1..10`. The validated local run used 8 attempts and 5 repetitions. Every repetition committed exactly one signal and rejected seven duplicates with SQLSTATE `23505`; all fixtures were removed through the existing engagement/outcome/user cleanup path.

## Migration-016 webhook-inbox hardening

The verifier now runs repeated first-claim and expired-lease reclaim races, preserving exact `lease_active` and `inbox_reclaim` semantics. Each scenario also verifies body-hash conflict rejection, processed duplicate behavior (`claimed=false`, `reason=processed`, `mutation=read_only`), durable body hash and event type, and `payload.applied=false`.

The new bounded race uses `MIGRATION_016_CONCURRENCY_ATTEMPTS=2..16` and `MIGRATION_016_CONCURRENCY_REPETITIONS=1..10`. The validated local run used 8 attempts and 5 repetitions, producing one first claimant and seven active-lease duplicates per repetition, followed by one reclaim winner and seven active-lease duplicates. All five repetitions passed and every replay-key fixture was deleted.

## CI contract

The isolated and restored PostgreSQL workflow steps now pass 8-attempt/3-repetition bounds to both migration-015 and migration-016 verifiers. Existing artifacts `restored-migration-015-trust-signals.json` and `restored-migration-016-webhook-inbox.json` remain the retained redacted evidence paths and continue through recovery hashing and bundle verification.

## Interpretation

The results demonstrate bounded persistence and state-machine behavior only. Migration-015 evidence does not promote a ranker or create trust outside verifier-owned verified outcomes. Migration-016 evidence does not establish webhook signature validity, delivery completion, event provenance, payment settlement, or ledger truth. These checks cannot clear release blockers, human sign-offs, Ed25519 custody, Railway target evidence, or settlement authority.
