# PayTray Migration-020 Outbox Lease-State Hardening

## Scope and safety boundary

This batch adds durable lease ownership and terminal delivery state to `outbox_events`. It is an additive database and delivery-worker hardening change for the PayTray AI-enabled time-to-money platform. It does not establish chain settlement, ledger truth, AI promotion, release eligibility, settlement authority, target readiness, production capacity, or an RTO.

All validation used local disposable PostgreSQL only. The invariant block remains:

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false
}
```

No human decisions, reviewer identities, signing keys, Railway settings, production credentials, live funds, mainnet transactions, or real user data were used.

## Migration-020 contract

`020_outbox_lease_state.sql` adds `lease_token`, `lease_acquired_at`, `lease_expires_at`, `last_attempt_at`, and `dead_lettered_at` to `outbox_events`. It creates partial indexes for active lease expiry, dead-letter evidence, and unprocessed attempt timestamps. Historical positive-attempt rows are backfilled before constraints are installed.

The four named constraints require a complete lease tuple with expiry after acquisition, prohibit processed events from retaining leases, require dead-letter records to remain unprocessed with at least one attempt, and require positive attempts to have a timestamp while zero-attempt events have none.

The delivery service now ignores active leases, records acquisition and attempt timestamps, generates a UUID lease token, clears leases on completion or retry failure, records terminal dead-letter state at the configured attempt bound, and applies an optional token guard so stale workers cannot finalize another worker’s delivery. Dry-run behavior remains non-mutating.

## Migration-020 verifier results

The command was executed against `postgresql://paytray_ci:paytray_ci@127.0.0.1:5432/paytray_migration020_ci` with `MIGRATION_020_CONTRACT_ISOLATED=true`.

| Check | Result |
|---|---:|
| Contract status | `verified` |
| Required columns | 5/5 |
| Required indexes | 3/3 |
| Required constraints | 4/4 |
| Malformed lease tuple | SQLSTATE `23514` passed |
| Invalid expiry order | SQLSTATE `23514` passed |
| Processed row retaining lease | SQLSTATE `23514` passed |
| Dead-letter without attempt | SQLSTATE `23514` passed |
| Attempt without timestamp | SQLSTATE `23514` passed |
| Concurrent claim attempts | 2 |
| Concurrent winners | 1 |
| Concurrent losers | 1 |
| Winning attempt count | 1 |
| Lease token returned | `true` |
| Fixture cleanup | 6 IDs, `cleanupPerformed=true` |

The race uses two independent PostgreSQL clients and `FOR UPDATE SKIP LOCKED` against one due fixture. Exactly one worker claims the event; the losing worker observes no claim. The report is redacted and carries `databaseIsolation=true`, `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.

## Migration-019 increased-load evidence inspected

The inspected migration-019 race artifact completed **10 repetitions**. Each repetition produced one committed attestation, one rollback from the competing transaction, one consumed challenge, one attestation record, and one audit event. The verifier reported `rollbackVerifiedCount=10`, `rollbackVerified=true`, `databaseIsolation=true`, `cleanupPerformed=true`, and immutable false/read-only safety fields. The expected competing error was `Reviewer attestation challenge was already consumed`.

The companion migration-019 constraint verifier reported `status=verified`, two required indexes, one challenge foreign key, 10 cleanup commits, and passed SQLSTATE coverage for malformed role/hash/time (`23514`), missing challenge (`23503`), duplicate challenge and role/commit (`23505`), immutable authority fields (`23514`), metadata mismatch (`23514`), required-column null (`23502`), and invalid consumed time (`23514`).

These are local-disposable concurrency and database-contract observations only. They do not prove production concurrency capacity or release readiness.

## Reusable skill package verification

The updated `paytray-shadow-review-release-attestation` skill contains the migration-020 verifier and `outbox-lease-state-contract.md` reference. The compiled archive was extracted and independently validated:

| Property | Result |
|---|---:|
| SHA-256 | `35dad791867dd90327b7e0cd7cae1e2cce8728d8072b3af6880a377d5e038c3a` |
| Sidecar match | `true` |
| ZIP integrity | passed |
| Archive entries | 47 |
| `SKILL.md` present | `true` |
| `references/` present | `true` |
| `scripts/` present | `true` |
| Extracted skill validator | `Skill is valid!` |
| Archive integrity verifier | `valid=true`, zero errors |

## CI integration

The quality workflow now runs migration-020 in the isolated PostgreSQL contract job and the restored recovery contract job. The restored artifact is included in the SHA-256 sidecar, recovery bundle verifier, and seven-day upload list. Migration discovery and recovery validation now require the ordered 001–020 set.

The next authoritative verification is the pushed GitHub Actions run for this batch. A green local run remains engineering evidence; it does not clear the pending human shadow reviews, four mandatory sign-offs, Ed25519 custody, authenticated Railway evidence, verifier freshness, reconciliation, or release-approval gates.
