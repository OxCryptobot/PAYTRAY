# Presentation Script: Migration 019 and Reviewer-Attestation Concurrency Verification

## Slide 1 — Title

**On-screen text:**

**PayTray Release Integrity Verification**
Migration 019 SQL Contracts and Reviewer-Attestation Concurrency

**Speaker script:**

This presentation explains the latest PayTray release-hardening work. The focus is not payment execution or model promotion. It is the infrastructure that proves reviewer attestations are structurally safe, bound to the correct release, and resistant to concurrent replay.

## Slide 2 — Why this boundary matters

**On-screen text:**

- PayTray is an AI-enabled time-to-money platform.
- Chain evidence remains economic truth.
- Reviewer evidence is necessary but non-authorizing.
- All verification outputs remain read-only.

**Speaker script:**

PayTray connects expert discovery, real-time collaboration, and ERC-20 payment streams. Because the system handles financial-integrity paths, release evidence must be durable and fail-closed. These tests verify evidence infrastructure only. They do not create human approvals, promote an AI candidate, deploy services, or grant settlement authority.

## Slide 3 — Migration 019 data model

**On-screen text:**

1. `reviewer_attestation_challenges`
2. `reviewer_attestations`
3. One challenge to one attestation
4. One attestation per role per release commit

**Speaker script:**

Migration 019 separates the server-issued challenge from the verified attestation. A challenge records the reviewer wallet, role, exact release commit, artifact digest, public-key fingerprint, decision, nonce, message hash, and expiry. A verified attestation references exactly one challenge. The database also enforces a unique pair of release commit and reviewer role.

## Slide 4 — SQL contract categories

**On-screen text:**

| Contract | Verified result |
|---|---|
| Role and hash format | `23514` check rejection |
| Challenge relationship | `23503` foreign-key rejection |
| Duplicate evidence | `23505` unique rejection |
| Missing required value | `23502` not-null rejection |
| Immutable authority fields | `23514` check rejection |

**Speaker script:**

The disposable contract verifier inserts deliberately invalid fixtures and expects exact PostgreSQL SQLSTATEs. It checks role allowlists, artifact and hash formats, temporal ordering, the challenge foreign key, duplicate challenge and role-commit records, required fields, metadata mirroring, and all immutable safety flags.

## Slide 5 — Immutable safety enforcement

**On-screen text:**

Migration 019 permanently constrains verified rows to:

```text
applied = false
release_eligible = false
settlement_authority = false
mutation = read_only
deployment_performed = false
settlement_mutation_performed = false
```

**Speaker script:**

The key property is database-level authority containment. An attestation cannot be stored as applied, release-eligible, settlement-authoritative, deployed, or financially mutating. The service emits the same values, but the PostgreSQL checks provide an independent persistence boundary.

## Slide 6 — Disposable contract suite results

**On-screen text:**

**Migration 019 contract verifier: VERIFIED**

- Catalog indexes and foreign key present
- Invalid role, hash, and timestamps rejected
- Missing challenge rejected
- Duplicate challenge rejected
- Duplicate role/commit rejected
- Immutable flags and metadata mismatch rejected
- Fixtures cleaned up

**Speaker script:**

The live disposable run passed every implemented contract case. It verified the expected unique indexes and foreign key, then cleaned up ten unique fixture-commit groups. The test output preserved `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`.

## Slide 7 — Reviewer-attestation flow

**On-screen text:**

1. Issue server challenge
2. Bind role, commit, artifact, fingerprint, decision, nonce, expiry
3. Sign exact message with EIP-191 wallet
4. Lock challenge row
5. Reconstruct and hash message
6. Recover signer and compare wallet
7. Consume once and insert attestation
8. Record redacted audit evidence

**Speaker script:**

The verifier does not trust caller-supplied message text. It reconstructs the message from the stored challenge, checks the stored message hash, recovers the Ethereum signer with EIP-191 verification, compares the recovered wallet with the challenge and authenticated wallet, and consumes the challenge exactly once before writing the attestation and audit record.

## Slide 8 — Two-transaction race design

**On-screen text:**

- Two independent PostgreSQL clients
- Two concurrent transactions
- Same challenge
- Same valid signature
- Row lock plus conditional consumption

**Speaker script:**

The concurrency script creates one disposable challenge and then starts two independent transactions against that same challenge. Both use the same valid signature. This simulates the race that could occur if duplicate verification requests arrive at the same time.

## Slide 9 — Concurrency test results

**On-screen text:**

**Attestation race: VERIFIED**

- Exactly 1 verification succeeded
- Exactly 1 verification was rejected as consumed
- Exactly 1 challenge was consumed
- Exactly 1 attestation row exists
- Exactly 1 audit event exists
- Safety flags remain false/read-only

**Speaker script:**

The live race passed. One transaction verified successfully and one received the consumed-challenge conflict. The database contained exactly one consumed challenge, one attestation, and one reviewer-attestation audit event. The durable record remained unapplied, non-eligible, non-authoritative, non-deployed, and read-only.

## Slide 10 — Negative unit-test coverage

**On-screen text:**

Focused reviewer-attestation tests now cover:

- Wallet mismatch
- Tampered message hash
- Expired challenge
- Malformed signature
- Consumed-challenge replay
- Successful wallet-bound recovery

**Speaker script:**

The service-level tests complement the live database race. They prove that an authenticated wallet mismatch is rejected, a tampered message hash is detected, an expired challenge is rejected before update or insert, malformed signature bytes are rejected before database access, and a consumed challenge cannot create a second attestation.

## Slide 11 — CI and recovery integration

**On-screen text:**

The checks now run in:

- Isolated source PostgreSQL contract job
- Disposable restored PostgreSQL recovery job
- Redacted JSON artifact capture
- SHA-256 recovery evidence fingerprint

**Speaker script:**

The migration contract and concurrency checks are wired into both the source PostgreSQL contract job and the restored-database recovery job. Recovery artifacts are captured even when a verification step fails, while the original exit status is preserved so CI remains fail-closed. Only redacted JSON and hashes are uploaded.

## Slide 12 — What this proves—and what it does not

**On-screen text:**

**Proves:**

- Migration 019 constraints exist and reject invalid records.
- Concurrent verification produces one durable attestation.
- Replay and malformed-input paths fail closed.

**Does not prove:**

- Human identity or organizational role authorization
- Completion of six shadow reviews
- Railway readiness
- Release approval or deployment
- Settlement authority

**Speaker script:**

These tests prove database and concurrency invariants under isolated disposable conditions. They do not prove that a human approved a release, that a reviewer is organizationally authorized, that the six pending shadow reviews are complete, or that a Railway target is ready. Those remain independent operator-controlled gates.

## Slide 13 — Current release boundary

**On-screen text:**

```text
releaseEligible = false
settlementAuthority = false
mutation = read_only
```

**Speaker script:**

The safety boundary remains unchanged. Passing the contract suite does not make PayTray release-eligible. Genuine four-role human sign-offs, four exact-commit cryptographic attestations, six terminal shadow-review decisions, target and recovery evidence, verifier and reconciliation evidence, key custody, release approval, and signed payload verification remain required.

## Slide 14 — Closing

**On-screen text:**

**Result:** Database and concurrency release contracts verified.
**Next:** Review CI artifacts, retain disposable evidence, and continue human-gated release preparation.

**Speaker script:**

The release-hardening result is a stronger, independently tested evidence boundary. Migration 019 rejects invalid or authoritative attestation states, and the concurrent verifier path produces exactly one durable result. PayTray remains correctly blocked until genuine human and environment evidence is supplied.

## Presenter reference commands

```bash
cd /home/ubuntu/projects/PAYTRAY

MIGRATION_019_CONTRACT_ISOLATED=true \
MIGRATION_019_CONTRACT_DATABASE_URL="$DISPOSABLE_DATABASE_URL" \
npm run backend:release:migration:019:check

ATTESTATION_RACE_ISOLATED=true \
ATTESTATION_RACE_DATABASE_URL="$DISPOSABLE_DATABASE_URL" \
npm run backend:release:attestation:race:check

DATABASE_URL='' npx vitest run \
  packages/backend/tests/reviewerAttestationService.test.js \
  packages/backend/tests/humanEvidenceWorksheet.test.js
```
