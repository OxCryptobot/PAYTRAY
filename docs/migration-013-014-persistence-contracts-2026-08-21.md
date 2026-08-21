# PayTray Migration-013/014 Persistence Contract Hardening

## Scope

This batch adds dedicated disposable PostgreSQL verifiers for the durable verifier cursor and shared webhook replay-claim tables. It does not change payment settlement, ledger truth, AI ranking promotion, release eligibility, settlement authority, target configuration, or human-review state.

All checks use local disposable PostgreSQL fixtures and preserve:

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false
}
```

No target credentials, real user data, human decisions, signing keys, Railway settings, live funds, or mainnet transactions were used.

## Migration-013 verifier cursors

The new `backend:release:migration:013:check` command asserts the exact `payment_verifier_cursors` columns (`chain_id`, `last_scanned_block`, `updated_at`), one primary key, and the named nonnegative-block CHECK constraint. It exercises negative block (`23514`), null block (`23502`), duplicate chain (`23505`), and one valid cursor fixture, then removes all four fixture chain IDs.

The local disposable report returned `status=verified`, `databaseIsolation=true`, `cleanupPerformed=true`, and false/read-only authority fields. The valid fixture used a nonnegative Base Sepolia-shaped block value but remains database evidence only; it does not prove cursor freshness, chain finality, or reconciliation.

## Migration-014 webhook replay claims

The new `backend:release:migration:014:check` command asserts the exact replay-claim columns, the `webhook_replay_claims` primary-key index, and `webhook_replay_claims_expiry_index`. It exercises null replay key (`23502`), duplicate replay key (`23505`), expired-key replacement through the durable store’s atomic `ON CONFLICT ... WHERE expires_at <= now` predicate, and two concurrent claims for one replay key with exactly one winner and one loser. Four replay-key fixtures are removed after the run.

The local disposable report returned `status=verified`, `databaseIsolation=true`, `cleanupPerformed=true`, `winners=1`, `losers=1`, and false/read-only authority fields. Signature validation remains upstream of claiming; this contract does not establish webhook authenticity, delivery completion, payment settlement, or ledger truth.

## CI and recovery evidence

Both commands are wired into the isolated PostgreSQL contract job and the restored recovery job. The redacted restored reports are included in the recovery SHA-256 sidecar, recovery bundle allowlist, bundle verification invocation, and retained artifact upload. Recovery regression tests cover both filenames and migration identifiers.

## Reusable skill update

The `paytray-shadow-review-release-attestation` skill now includes:

- `scripts/verify-migration-013-verifier-cursors.mjs`;
- `scripts/verify-migration-014-webhook-replay-claims.mjs`; and
- `references/migration-013-014-contracts.md`.

The compiled archive was extracted and validated with 50 entries. Its SHA-256 is recorded in the delivered sidecar and matched by the archive-integrity verifier.

## Remaining boundaries

These verifiers provide engineering evidence for schema and concurrency behavior only. They do not clear the six pending shadow reviews, four mandatory human sign-offs, Ed25519 custody, authenticated Railway evidence, target backup/restore, fresh verifier/reconciliation evidence, release approval, or the final controlled authority path.
