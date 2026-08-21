# Migration-019 Concurrency Repeat and Skill Archive Integrity Audit

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**Evidence boundary:** fresh local disposable PostgreSQL databases only

## Repeat high-frequency race run

A fresh run repeated the bounded migration-019 contention probe with four isolated PostgreSQL workers and ten repetitions per worker. The run produced **40 races and 80 concurrent verification attempts**.

| Metric | Result |
|---|---:|
| Workers | 4 |
| Repetitions per worker | 10 |
| Total races | 40 |
| Total concurrent attempts | 80 |
| Committed winners | 40/40 |
| Rolled-back losers | 40/40 |
| `rollbackVerifiedCount` | 10 per worker |
| Final attestation rows | 1 per race |
| Final consumed challenges | 1 per race |
| Final audit events | 1 per race |
| Worker database isolation | 4/4 true |
| Cleanup | 4/4 true |
| Aggregate | `valid=true` |

Every loser reported `commitPerformed=false`, `rollbackPerformed=true`, and the expected consumed-challenge conflict. Every winner committed exactly one attestation and one audit event. No duplicate rows or integrity failures were observed. Safety fields remained `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only` for all workers.

This is repeatable engineering evidence from bounded disposable contention. It is not a production concurrency capacity claim, application transaction-throughput measurement, RTO decision, production SLO, release gate, target evidence, reviewer approval, or settlement authority.

## Compiled skill archive integrity

The corrected skill archive was extracted into a temporary directory and validated before executing its bundled runners.

| Check | Result |
|---|---|
| Archive SHA-256 | `a530f6949e3e1a688a67ea0724027f3da2f5a2e83ef2c855dca35b64c52709f0` |
| Sidecar match | `true` |
| Archive entries | 41 |
| `SKILL.md` | Present |
| References/scripts groups | Present |
| Skill validator | Passed |
| Workflow steps | 26 |
| References linked | 26/26 |
| Validation scripts discovered | 11 |
| Execution-integrity report | `valid=true`, zero errors/warnings |
| Rollback report | `valid=true`, 10/10 runs |
| Archive-integrity report | `valid=true` |
| Migration integration audit | `valid=true` |

The archive-integrity verifier requires a lowercase 64-character sidecar digest, required archive groups, and valid extracted integrity and rollback reports. A prior negative control with an all-zero sidecar was correctly rejected. The missing-script condition discovered during the first repeat packaging attempt was corrected by restoring `verify-skill-archive-integrity.mjs`; the corrected archive now contains and discovers the script.

## Safety interpretation

The result is read-only engineering evidence. It does not authorize human shadow-review decisions, four-role sign-offs, Ed25519 key custody, Railway target configuration, deployment, live funds, mainnet transactions, release eligibility, payment mutation, or settlement authority.
