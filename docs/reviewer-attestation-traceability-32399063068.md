# Migration 019 Reviewer-Attestation Negative-Path Traceability

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Source CI run:** [32399063068](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32399063068)  
**Source taxonomy commit:** `b401cdc62ac9a73920101cbc26b1c951ccfa1782`  
**Migration:** `019_reviewer_attestations`  
**Exact traceability JSON:** [`reviewer-attestation-traceability-32399063068.json`](./reviewer-attestation-traceability-32399063068.json)

## Verification result

The exact migration-019 category contains **30 PostgreSQL negative-path records**: 15 from `Isolated PostgreSQL route contract` and 15 from `Disposable backup and isolated recovery contract`. Every record maps to exactly one migration constraint, one verifier assertion case, and one expected SQLSTATE. The reusable verifier returned `valid=true` with zero errors.

| Group | Assertion cases | Expected SQLSTATE | Records |
|---|---|---:|---:|
| Challenge role, artifact hash, expiry and consumed ordering | `invalidChallengeRole`, `invalidChallengeHash`, `invalidChallengeTime`, `invalidConsumedTime` | `23514` | 8 |
| Missing challenge reference | `missingChallengeForeignKey` | `23503` | 2 |
| Duplicate challenge attestation | `duplicateChallenge` | `23505` | 2 |
| Duplicate role/release commit | `duplicateRoleCommit` | `23505` | 2 |
| Immutable authority flags | `immutableFlags.applied`, `immutableFlags.releaseEligible`, `immutableFlags.settlementAuthority`, `immutableFlags.deploymentPerformed`, `immutableFlags.settlementMutationPerformed` | `23514` | 10 |
| Read-only mutation | `immutableMutation` | `23514` | 2 |
| Metadata mirror | `metadataMirror` | `23514` | 2 |
| Required reviewer wallet | `requiredColumn` | `23502` | 2 |
| **Total** | **15 case entries** |  | **30** |

## Exact source mapping

**Migration SQL:** `packages/backend/migrations/019_reviewer_attestations.sql`  
**Contract verifier:** `packages/backend/scripts/verify-migration-019-constraints.mjs`

| Verifier assertion | Migration invariant | SQLSTATE | Raw CI constraint/message family |
|---|---|---:|---|
| `invalidChallengeRole` | Challenge role allowlist: `release_operator`, `protocol_finance`, `ai_data`, `security` | `23514` | `reviewer_attestation_challenges_role_check` |
| `invalidChallengeHash` | Artifact hash is lowercase 64-character hexadecimal | `23514` | `reviewer_attestation_challenges_artifact_sha256_check` |
| `invalidChallengeTime` | `expires_at > issued_at` | `23514` | `reviewer_attestation_challenges_check` |
| `invalidConsumedTime` | `consumed_at IS NULL OR consumed_at >= issued_at` | `23514` | `reviewer_attestation_challenges_check1` |
| `missingChallengeForeignKey` | Attestation `challenge_id` references an existing challenge | `23503` | `reviewer_attestations_challenge_id_fkey` |
| `duplicateChallenge` | `challenge_id` cannot be attested twice | `23505` | `reviewer_attestations_challenge_id_key` |
| `duplicateRoleCommit` | `(release_commit, role)` is unique | `23505` | `reviewer_attestations_role_commit_index` |
| `immutableFlags.applied` | `applied = false` | `23514` | `reviewer_attestations_applied_check` |
| `immutableFlags.releaseEligible` | `release_eligible = false` | `23514` | `reviewer_attestations_release_eligible_check` |
| `immutableFlags.settlementAuthority` | `settlement_authority = false` | `23514` | `reviewer_attestations_settlement_authority_check` |
| `immutableFlags.deploymentPerformed` | `deployment_performed = false` | `23514` | `reviewer_attestations_deployment_performed_check` |
| `immutableFlags.settlementMutationPerformed` | `settlement_mutation_performed = false` | `23514` | `reviewer_attestations_settlement_mutation_performed_check` |
| `immutableMutation` | `mutation = 'read_only'` | `23514` | `reviewer_attestations_mutation_check` |
| `metadataMirror` | Metadata mirrors reviewer wallet, commit, artifact hash, fingerprint, digest, and verification-only authority | `23514` | `reviewer_attestations_check2` in the emitted CI record |
| `requiredColumn` | `reviewer_wallet` is required | `23502` | `null value in column "reviewer_wallet" ... violates not-null constraint` |

The raw CI artifact contains two records for each case: one in the isolated route-contract job and one in the disposable recovery-contract job. The recovery records are restored local-database engineering evidence only.

## Assertion behavior

`verify-migration-019-constraints.mjs` requires `MIGRATION_019_CONTRACT_ISOLATED=true` and rejects non-local/non-test/non-disposable database URLs before connection. Its `expectSqlState` wrapper executes each negative operation inside a transaction, rolls back the transaction, and asserts the exact PostgreSQL error code. Fixture cleanup deletes reviewer attestations and challenges by disposable release commit.

The verifier also validates reviewer-attestation indexes and the challenge foreign key, creates deterministic disposable fixtures, and emits only read-only evidence. It preserves `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `deploymentPerformed=false`, and `settlementMutationPerformed=false`.

## Reusable skill addition

The process is now reusable through `paytray-shadow-review-release-attestation` with:

- `scripts/verify-reviewer-attestation-traceability.mjs` for exact 30-record mapping.
- `references/reviewer-attestation-traceability.md` for progressive-disclosure workflow guidance.
- A direct navigation entry from `SKILL.md` for CI/reviewer-attestation audits.

This process never submits reviewer decisions, fabricates identities, signs messages, accesses private keys, mutates target data, grants release authority, or treats synthetic fixtures as human evidence.
