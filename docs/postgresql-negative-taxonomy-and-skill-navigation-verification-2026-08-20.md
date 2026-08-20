# PostgreSQL Negative-Taxonomy and Skill-Navigation Verification

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**Source CI run:** [32388405081](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32388405081)  
**Source commit:** `7ed8ae539bfe81cba9223fd6ad3bb46bf2275ab1`  
**Taxonomy artifact:** [`ci-negative-path-lines-32388405081.json`](./ci-negative-path-lines-32388405081.json)

## PostgreSQL record verification

The exact `postgresConstraintNegativePath.lines` array contains **64 records**. The reusable `verify-postgres-taxonomy.mjs` script was run against the committed taxonomy artifact. It validated every record individually rather than relying only on aggregate counts.

| Check | Result |
|---|---:|
| Record count | 64/64 |
| Expected count | 64 |
| Unique positive source line numbers | 64/64 |
| PostgreSQL `ERROR:` marker | 64/64 |
| Exactly one constraint family per record | 64/64 |
| Approved owning jobs | 64/64 |
| Expected cleanup step `Stop containers` | 64/64 |
| Validation errors | 0 |
| Overall verifier result | `valid=true` |

### Constraint-family distribution

| PostgreSQL family | Count | Meaning of the negative probe |
|---|---:|---|
| CHECK | 46 | Invalid status/report/invariant values were rejected by table checks. |
| Unique | 8 | Duplicate durable identifiers were rejected. |
| Foreign key | 8 | References to absent users or engagements were rejected. |
| NOT NULL | 2 | Required fields were rejected when omitted. |
| **Total** | **64** | **All records matched exactly one family.** |

### Job and step provenance

| Job and step | Count | Interpretation |
|---|---:|---|
| `Isolated PostgreSQL route contract :: Stop containers` | 32 | Contract probes exercised migration and route-integrity constraints in the isolated PostgreSQL service. |
| `Disposable backup and isolated recovery contract :: Stop containers` | 32 | Equivalent constraints were exercised against the restored disposable database. |

The source line numbers are unique across the 64 records. The records carry the original raw PostgreSQL line and the GitHub Actions job/step fields. The verifier rejects a record that lacks the PostgreSQL `ERROR:` marker, matches zero or multiple families, comes from an unexpected job, or appears outside the expected cleanup step.

Representative records include the following exact source forms:

```text
new row for relation "operations_quality_runs" violates check constraint "operations_quality_runs_status_check"
new row for relation "operations_quality_runs" violates check constraint "operations_quality_runs_report_check"
duplicate key value violates unique constraint "operations_quality_runs_run_id_key"
insert or update on table "verified_trust_signals" violates foreign key constraint "verified_trust_signals_subject_user_id_fkey"
```

These messages are expected only because the owning contract tests deliberately submit invalid records and assert rejection. The messages do not independently prove migration completeness, recovery correctness, production readiness, or payment/settlement authority. Successful surrounding jobs and restored-contract assertions remain necessary.

## Updated SKILL.md progressive-disclosure review

The updated `paytray-shadow-review-release-attestation/SKILL.md` remains concise at 136 lines and keeps variant-specific details in directly linked `references/` files. The navigation now has both detailed reference triggers and a task-oriented read-order index.

| Navigation rule | Verification |
|---|---|
| Core workflow stays in `SKILL.md` | Pass. The file contains the safety boundary, 26-step workflow, commands, and interpretation rules. |
| Variant-specific detail stays in references | Pass. Worksheet, cryptographic, CI, PostgreSQL/recovery, staging, AI, and deployment detail remain in separate files. |
| References stay one level below the skill | Pass. Navigation points to `references/<file>.md`; no nested reference path is required. |
| CI taxonomy is conditionally loaded | Pass. `ci-negative-path-taxonomy.md` is directed only to exact source-line and process-failure audits. |
| PostgreSQL verifier is discoverable | Pass. The taxonomy reference names `scripts/verify-postgres-taxonomy.mjs` and its checks. |
| Sensitive/authority boundary remains global | Pass. Navigation explicitly states that reference examples never authorize mutation, submissions, key use, or authority-field changes. |
| Target evidence remains separate from local evidence | Pass. The navigation preserves the `local_disposable` versus `authenticated_target` distinction. |
| No deep reference chains | Pass. The task index links directly from `SKILL.md` to the required references. |

The task-oriented read order now directs agents to load only the first reference required for the active work and then load additional references conditionally. This reduces context bloat while preserving the existing detailed navigation for exact commands and contracts.

## Validation commands and results

```bash
CI_NEGATIVE_JSON_PATH=/home/ubuntu/projects/PAYTRAY/docs/ci-negative-path-lines-32388405081.json \
CI_POSTGRES_VERIFICATION_OUTPUT_PATH=/tmp/paytray-postgres-taxonomy-verification.json \
EXPECT_POSTGRES_RECORD_COUNT=64 \
node /home/ubuntu/skills/paytray-shadow-review-release-attestation/scripts/verify-postgres-taxonomy.mjs
```

Result: `valid=true`, 64 records, 46 CHECK, 8 unique, 8 foreign-key, 2 NOT NULL, 64 unique source lines, and zero errors.

```bash
python /home/ubuntu/skills/skill-creator/scripts/quick_validate.py \
  /home/ubuntu/skills/paytray-shadow-review-release-attestation
```

Result: `Skill is valid!`

This document is engineering evidence only. It does not clear the pending six shadow reviews, four human sign-offs, Ed25519 custody, Railway target evidence, verifier cursor, deployment gate, release authority, or settlement authority.
