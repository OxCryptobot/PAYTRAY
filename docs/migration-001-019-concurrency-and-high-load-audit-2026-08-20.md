# PayTray Migration 001–019 Concurrency and High-Load Integration Audit

**Date:** 2026-08-20
**Repository:** `OxCryptobot/PAYTRAY`
**Branch:** `paytray/batch-delivery`
**Evidence boundary:** fresh local disposable PostgreSQL only

## Executive result

All **19 migration files**, from `001_init.sql` through `019_reviewer_attestations.sql`, were present in contiguous order and applied successfully to a fresh disposable PostgreSQL database. The static audit found no explicit `FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`, `DEFERRABLE`, or `SERIALIZABLE` statements in migration SQL. It did find 19 unique-boundary occurrences, 31 foreign-key/reference occurrences, 91 CHECK constraints, and five partial-index patterns. These are review targets, not proof of safety or vulnerability.

The runtime integration phase verified migrations 001–019 and then exercised dedicated contracts for migrations 015, 016, 018, and 019. It also ran ten bounded migration-019 reviewer-attestation race repetitions and high-load component tests for webhook replay, webhook inbox, reviewer attestations, and outbox processing. The aggregate summary returned `valid=true`, with no failure markers and all safety fields preserved.

## Static migration review

| Area | Result |
|---|---:|
| Migration files | 19/19 |
| Sequence | `001` through `019`, contiguous |
| Explicit row-locking syntax in migration SQL | 0 |
| `SKIP LOCKED` in migration SQL | 0 |
| `ON CONFLICT` in migration SQL | 0 |
| DEFERRABLE/SERIALIZABLE syntax | 0 |
| Unique constraints/index patterns | 19 |
| Foreign-key/reference patterns | 31 |
| CHECK constraints | 91 |
| Partial-index patterns | 5 |
| Static audit | `valid=true` |

The audit mapped dedicated runtime coverage for migration 015 trust signals, migration 016 webhook inbox/replay behavior, migration 018 operations-quality constraints, and migration 019 reviewer attestations and transaction races. Migrations 001–013 and 014/017 do not have dedicated migration-specific runtime verifiers registered in this audit; they remain **coverage gaps requiring future targeted contract tests**, not findings of safety and not evidence of a hidden vulnerability.

## Runtime migration and component verification

| Runtime check | Result |
|---|---|
| Fresh disposable database | Passed |
| Migration order 001–019 | Verified |
| Migration 015 trust-signal constraints | Verified |
| Migration 016 webhook-inbox race/constraints | Verified |
| Migration 018 operations-quality constraints | Verified |
| Migration 019 reviewer-attestation constraints | Verified |
| Migration 019 race, 10 repetitions | Verified |
| High-load webhook replay component test | Passed |
| Webhook inbox service tests | Passed |
| Reviewer-attestation service tests | Passed |
| Outbox processor/worker tests | Passed |
| Failure markers | None |
| Aggregate result | `valid=true` |

The migration-019 race phase used `ATTESTATION_RACE_ISOLATED=true` and `ATTESTATION_RACE_REPETITIONS=10`. Each repetition requires exactly one committed winner, one rolled-back loser, one attestation row, one consumed challenge, and one audit event. The high-load test uses 100 isolated webhook events and verifies exact signatures plus rejection of every duplicate replay.

## Reusable skill workflow

Added `scripts/audit-migration-concurrency.mjs` and `references/migration-concurrency-audit.md` to the PayTray reusable skill. The auditor enforces the contiguous 001–019 inventory, reports concurrency-sensitive SQL patterns, maps known runtime verifiers/tests, and explicitly labels static results as review targets. The reference documents the disposable runtime sequence and strict interpretation boundaries.

## Fail-closed interpretation

> A clean static migration scan cannot prove that an application race is impossible.

Runtime guarantees require transaction tests that exercise lock order, atomic claims/consumption, duplicate writes, rollback, and cleanup. All local results are engineering evidence only. They cannot establish production capacity, application TPS, production SLOs, RTO clearance, release eligibility, payment mutation, settlement authority, human approval, target-environment evidence, deployment success, or Ed25519 custody.

Every promoted summary retains `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`. No live funds, mainnet transaction, real user data, human decision, reviewer identity, approval token, private key, or target setting was fabricated or used.

## Skill execution evidence

The bundled `run-migration-integration-high-load.sh` runner was executed directly from the PayTray skill with `PAYTRAY_HIGH_LOAD_ISOLATED=true` and `ATTESTATION_RACE_REPETITIONS=10`; it reproduced the 001–019 migration verification and component-load summary with `valid=true`. The compiled skill archive was then extracted and validated. Its SHA-256 is `d4cf053a33166e8160d133b9e3d8236c312a9b19e23201146cc841a81a86146f`, matching its sidecar exactly. The extracted skill reported 26 workflow steps, 27/27 linked references, 13 discoverable validation scripts, and zero execution-integrity errors or warnings.

All evidence remains engineering-only and preserves `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.
