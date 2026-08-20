# CI 32399063068 and Skill Execution-Integrity Audit

**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**CI run:** [32399063068](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32399063068)  
**Bound commit:** `b401cdc62ac9a73920101cbc26b1c951ccfa1782`  
**Exact taxonomy artifact:** [`ci-negative-path-lines-32399063068.json`](./ci-negative-path-lines-32399063068.json)

## Latest CI taxonomy review

The complete workflow log was reprocessed with the reusable `extract-ci-negative-lines.mjs` script. The latest run reproduced the established taxonomy without drift:

| Category | Count | Owning context | Interpretation |
|---|---:|---|---|
| `errorHandlerNegativePath` | 67 | 60 shared quality-gate records; 7 read-only release-gate evidence records | Deliberate route/service rejection and fail-closed dependency diagnostics. |
| `postgresConstraintNegativePath` | 64 | 32 isolated route-contract cleanup records; 32 disposable recovery cleanup records | Deliberate PostgreSQL constraint probes. |
| `expectedTestStderr` | 1 | Shared quality gate | Expected diagnostic output. |
| `expectedArtifactStatus` | 5 | Restored contract and reviewer-attestation checks | Expected artifact/status diagnostics. |
| `otherErrorLike` | 27 | Quality, release-gate, and artifact steps | Informational or configuration-context records requiring taxonomy review. |
| `processFailureSignal` | **0** | None | No non-zero exit, failed job, `Unhandled`, or `FATAL` signal. |
| **Total error-like** | **164** | Eight successful jobs | Raw error text did not represent workflow failure. |

Representative latest records are bound to new log positions. The shared quality gate still exercises invalid signature length, missing access token, expired/invalid challenge, missing scopes, and unavailable database service paths. The PostgreSQL cleanup records still use standard messages such as `operations_quality_runs_status_check`, `operations_quality_runs_report_check`, and `operations_quality_runs_report_check1` violations. The full exact source records remain unchanged in the JSON artifact, with line number, job, step, normalized message, and raw line.

## Progressive-disclosure and execution-integrity review

The updated `paytray-shadow-review-release-attestation` skill was checked using both the official skill validator and the new `verify-skill-execution-integrity.mjs` script.

| Integrity property | Result |
|---|---:|
| YAML frontmatter with name and description | Pass |
| `SKILL.md` line count | 136; below the 500-line limit |
| Sequential workflow steps | 26 |
| Direct reference links | 22 unique files linked; 22 files present |
| Nested reference links | None; all references remain one level below `SKILL.md` |
| Progressive-disclosure section | Present with task/read-order table |
| Required safety terms | All present, case-insensitive check |
| Referenced reusable scripts | Present and discoverable |
| Orphan reference warnings | 0 |
| Integrity errors | 0 |
| `quick_validate.py` | `Skill is valid!` |
| Overall execution-integrity result | `valid=true` |

The integrity verifier intentionally checks that the workflow retains `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `shadow_only`, Base Sepolia, `local_disposable`, and `authenticated_target` boundaries. It also checks that reference examples cannot be mistaken for authorization to mutate a target, submit a human decision, use a private key, or change authority fields.

### Corrective integrity loop

The first local integrity run correctly found two navigation issues: three on-disk references were not linked from the progressive-disclosure index, and the case-sensitive safety-term check did not recognize the capitalized `Never invent` rule. The skill was corrected by directly linking `cryptographic-signatures-and-protected-paths.md`, `human-evidence-custody-and-blocker-plan.md`, and `repeated-confidence-and-pgstatio-analysis.md`, and by making safety-term detection case-insensitive. The rerun completed with zero errors and zero warnings.

The reusable skill now exposes four read-only validation utilities: `extract-ci-negative-lines.mjs`, `verify-postgres-taxonomy.mjs`, `audit-postgres-constraint-patterns.mjs`, and `verify-skill-execution-integrity.mjs`. These utilities provide evidence checks only and cannot grant release or settlement authority.

## Batch boundary

This batch reviews engineering evidence from a successful CI run and hardens skill execution integrity. It does not clear the six shadow reviews, four human sign-offs, Ed25519 custody, Railway target settings, fresh verifier cursor, deployment authorization, `releaseEligible`, or settlement authority. Those fields remain fail-closed.
