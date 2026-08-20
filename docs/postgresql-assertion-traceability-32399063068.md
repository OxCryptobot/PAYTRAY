# PostgreSQL Negative-Path Assertion Traceability

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**CI run:** [32399063068](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32399063068)  
**Taxonomy commit:** `b401cdc62ac9a73920101cbc26b1c951ccfa1782`  
**Traceability artifact:** [`postgresql-assertion-traceability-32399063068.json`](./postgresql-assertion-traceability-32399063068.json)

## Executive result

The complete PostgreSQL negative-path category contains **64 records**. The reusable traceability verifier mapped all records to migrations 015, 018, and 019, their SQL source files, their contract-verifier scripts, their expected SQLSTATE assertions, and the two CI jobs that execute the same contract profile. The result is `valid=true` with zero mapping errors.

Each owning job contains exactly 32 records: 23 CHECK violations, four unique violations, four foreign-key violations, and one NOT NULL violation. The two jobs are the isolated route contract and the disposable backup/recovery contract. The recovery copy is restored local-database engineering evidence only.

| Constraint family | Isolated route job | Disposable recovery job | Total |
|---|---:|---:|---:|
| CHECK / SQLSTATE `23514` | 23 | 23 | 46 |
| Unique / SQLSTATE `23505` | 4 | 4 | 8 |
| Foreign key / SQLSTATE `23503` | 4 | 4 | 8 |
| NOT NULL / SQLSTATE `23502` | 1 | 1 | 2 |
| **Total** | **32** | **32** | **64** |

## Migration 015: verifier-owned trust signals

**SQL source:** `packages/backend/migrations/015_verified_trust_signals.sql`  
**Contract verifier:** `packages/backend/scripts/verify-migration-015-trust-signals.mjs`  
**Records across both CI jobs:** 14

The verifier creates disposable users, an engagement, and a verifier-marked outcome, then checks catalog foreign keys and indexes before running negative inserts inside transactions. Every negative insert is rolled back and checks the exact PostgreSQL SQLSTATE.

| Assertion case | SQL invariant | Expected SQLSTATE | Records across both jobs |
|---|---|---:|---:|
| `foreignKeys.subjectUser` | `verified_trust_signals.subject_user_id` must reference `users(id)` | `23503` | 2 |
| `foreignKeys.engagement` | `engagement_id` must reference `engagements(id)` | `23503` | 2 |
| `foreignKeys.outcome` | `outcome_id` must reference `engagement_outcome_events(id)` | `23503` | 2 |
| `polarity` | Polarity must be `positive` or `neutral` | `23514` | 2 |
| `score` | Score must be nonnegative | `23514` | 2 |
| `rankingEligibility` | `eligible_for_ranking` cannot be promoted to true | `23514` | 2 |
| `uniqueness` | `(subject_user_id, outcome_id, signal_type)` must be unique | `23505` | 2 |
| **Subtotal** |  |  | **14** |

The valid control insert also asserts immutable defaults: `eligible_for_ranking=false`, positive polarity, score `3`, verifier provenance, and read-only authority metadata. Cleanup removes trust signals, outcome events, engagements, and fixture users.

## Migration 018: operations-quality evidence

**SQL source:** `packages/backend/migrations/018_operations_quality_runs.sql`  
**Contract verifier:** `packages/backend/scripts/verify-migration-018-constraints.mjs`  
**Records across both CI jobs:** 20

The verifier first checks the two expected indexes, inserts a safe operator-blocked report, confirms its canonical SHA-256 hash and false/read-only authority fields, then runs invalid inserts using `expectSqlState`. Each probe is wrapped in `BEGIN`/`ROLLBACK`, and all fixture run IDs are deleted during cleanup.

| Assertion case | SQL invariant exercised | Expected SQLSTATE | Records across both jobs |
|---|---|---:|---:|
| `invalidStatus` | Status must be `passed`, `operator_blocked`, or `failed` | `23514` | 2 |
| `negativeCount` | `check_count` cannot be negative | `23514` | 2 |
| `countReconciliation` | Passed + blockers + unexpected failures must equal check count | `23514` | 2 |
| `immutableReports` | Five report authority fields remain false/read-only: release eligibility, settlement authority, deployment, settlement mutation, and mutation mode | `23514` | 10 |
| `invalidReportHash` | Report hash must be lowercase 64-character hexadecimal | `23514` | 2 |
| `duplicateRunId` | Durable `run_id` must be unique | `23505` | 2 |
| **Subtotal** |  |  | **20** |

The 18 CHECK records correspond to the nine operations-quality CHECK constraints, each emitted once in each CI job. The two unique records correspond to `operations_quality_runs_run_id_key`, also repeated in both jobs.

## Migration 019: reviewer attestations

**SQL source:** `packages/backend/migrations/019_reviewer_attestations.sql`  
**Contract verifier:** `packages/backend/scripts/verify-migration-019-constraints.mjs`  
**Records across both CI jobs:** 30

The verifier requires an isolated local/test/disposable PostgreSQL URL, runs migrations, checks reviewer-attestation indexes and the challenge foreign key, and creates deterministic disposable fixtures. Negative probes run through transaction wrappers that roll back on failure. Fixture rows are removed by release commit after the suite.

| Assertion case | SQL invariant exercised | Expected SQLSTATE | Records across both jobs |
|---|---|---:|---:|
| `invalidChallengeRole` | Challenge role must be one of the four allowed reviewer roles | `23514` | 2 |
| `invalidChallengeHash` | Challenge artifact hash must be lowercase 64-character hexadecimal | `23514` | 2 |
| `invalidChallengeTime` | Challenge expiry must be after issuance | `23514` | 2 |
| `missingChallengeForeignKey` | Attestation challenge must exist | `23503` | 2 |
| `duplicateChallenge` | Challenge-attestation identity must be unique | `23505` | 2 |
| `duplicateRoleCommit` | One attestation per role and release commit | `23505` | 2 |
| `immutableFlags` | `applied`, `release_eligible`, `settlement_authority`, `deployment_performed`, and `settlement_mutation_performed` must remain false | `23514` | 10 |
| `immutableMutation` | Mutation mode must remain `read_only` | `23514` | 2 |
| `metadataMirror` | Metadata must mirror reviewer wallet, commit, artifact hash, public-key fingerprint, attestation digest, and verification-only authority | `23514` | 2 |
| `requiredColumn` | Reviewer wallet is required | `23502` | 2 |
| `invalidConsumedTime` | Consumed timestamp cannot precede issuance | `23514` | 2 |
| **Subtotal** |  |  | **30** |

The 22 CHECK records correspond to 11 reviewer-attestation/challenge CHECK probes per CI job. The four unique records comprise two challenge-attestation identity records and two role/commit index records per job. The two foreign-key records are `reviewer_attestations_challenge_id_fkey`, and the two NOT NULL records exercise `reviewer_wallet`.

## Exact constraint-name coverage

The taxonomy’s raw messages show the expected PostgreSQL constraint names. Across both jobs, the 23 CHECK names occur twice each, except the operations-quality generic count check, which occurs four times because it represents two adjacent count invariants repeated across both jobs. The unique, foreign-key, and NOT NULL families match the migration source names and the verifier cases described above.

## Strict fail-closed boundary

This mapping proves that negative database operations were deliberately rejected by the expected constraints and that the repository’s contract verifiers assert exact SQLSTATE values. It does **not** prove target readiness, deployment success, human approval, operator-key custody, Railway configuration, settlement, or production authority. All evidence remains bounded by `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `deploymentPerformed=false`, and `settlementMutationPerformed=false`.
