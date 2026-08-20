# Reviewer-Attestation Rollback Race and Migration Suite

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**Local target:** fresh disposable PostgreSQL database, destroyed after the run  
**Evidence:** [`reviewer-attestation-rollback-race-local-2026-08-20.json`](./reviewer-attestation-rollback-race-local-2026-08-20.json)

## Rollback-race result

The migration-019 concurrency verifier ran **five bounded repetitions** against a fresh disposable PostgreSQL database. Each repetition started two concurrent verification transactions for the same reviewer-attestation challenge.

| Invariant | Result |
|---|---:|
| Repetitions requested | 5 |
| Repetitions observed | 5 |
| Winning committed transactions | 5 |
| Losing rejected transactions | 5 |
| Losing transactions reporting `rollbackPerformed=true` | 5 |
| Attestation rows remaining per repetition | 1 |
| Consumed challenge rows per repetition | 1 |
| Financial audit rows per repetition | 1 |
| Cleanup completed | true |
| `releaseEligible` | false |
| `settlementAuthority` | false |
| `mutation` | `read_only` |
| Overall rollback report | `valid=true` |

The losing transaction consistently returned `Reviewer attestation challenge was already consumed`, reported `commitPerformed=false` and `rollbackPerformed=true`, and left no duplicate attestation or audit record. The winning transaction committed the single attestation and audit event. The service-layer `SELECT ... FOR UPDATE` and atomic `UPDATE ... consumed_at IS NULL RETURNING` sequence therefore remains serialized under concurrent attempts.

A first local attempt was rejected before connection because its disposable database name did not match the verifier’s allowlist. The run was corrected by using an explicitly `disposable` database name; no non-allowlisted target was accessed.

## Complete migration integration suite

A fresh disposable database applied and validated the full migration sequence from `001_init` through `019_reviewer_attestations`.

| Component | Result |
|---|---|
| Migration order and schema contract | `status=ok`, migrations 001–019 present |
| Migration 015 trust-signal contract | verified; SQLSTATE `23503`, `23514`, `23505`; cleanup true |
| Migration 016 webhook-inbox race | verified; claim/reclaim semantics and read-only safety fields passed |
| Migration 018 operations-quality constraints | verified; SQLSTATE `23514`, `23505`; cleanup of 10 disposable runs |
| Migration 019 reviewer-attestation constraints | verified; all 15 assertion cases and cleanup of 10 commits |
| Migration 019 repeated attestation race | verified; five rollback-confirmed repetitions |
| Release/settlement authority fields | false/read-only throughout |

Migration-order verification confirmed all 19 migration names and the expected financial, discovery, verifier, reviewer, webhook, outbox, and trust-signal tables. No persistent disposable database was retained.

## Reusable skill and archive validation

The compiled `paytray-shadow-review-release-attestation` archive was extracted into a clean temporary directory before validation. The archive was not executed as an opaque blob.

| Archive validation | Result |
|---|---|
| Compiled archive SHA-256 | `80ed7f994d7037002dfeca30fef3ff16b5723fbb1428f7a2721645b5ff7c5ce3` |
| Extracted `SKILL.md` validation | passed |
| Workflow steps | 26 |
| References on disk and linked | 25/25 |
| Execution-integrity errors/warnings | 0/0 |
| Bundled rollback-report validator | `valid=true` |
| Archive safety rule | extraction required before validation; arbitrary contents not executed |

## Safety boundary

This batch proves transaction isolation and rollback behavior in disposable local infrastructure. It does not constitute a human reviewer decision, shadow-review approval, Ed25519 custody proof, Railway target evidence, deployment authorization, release authority, or settlement authority. No real user data, live funds, mainnet transaction, reviewer identity, approval token, or private key was used.
