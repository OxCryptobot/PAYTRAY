# PayTray CI Negative-Path and 26-Step Error-Handling Audit

**Author:** Manus AI  
**Date:** 2026-08-20  
**Repository:** `OxCryptobot/PAYTRAY`  
**Branch:** `paytray/batch-delivery`  
**Skill:** `paytray-shadow-review-release-attestation`  
**Audited CI run:** [32388405081](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32388405081)  
**Bound commit:** `7ed8ae539bfe81cba9223fd6ad3bb46bf2275ab1`

## Executive conclusion

The reusable PayTray release-attestation skill contains **26 sequential workflow steps**. The complete review found an explicit rejection, blocking, stop, or evidence-only boundary in every step. The workflow consistently keeps AI ranking shadow-only, treats verifier-owned chain events as economic truth, preserves human control, and prevents local engineering evidence from being interpreted as target readiness or release authority. The package remains valid under the skill-creator validator.

The CI forensic audit of run `32388405081` classified **164 error-like log lines**. There were **67 route/service-negative records**, **64 PostgreSQL constraint-negative records**, one expected test-stderr record, five expected artifact/status records, 27 other informational or configuration records, and **zero process-failure signals**. All eight jobs completed successfully. The negative records are therefore evidence that rejection and integrity boundaries were exercised, not evidence that the workflow failed.

The 67 route/service category contains two distinct groups: 40 structured `ErrorHandler` route logs from the shared quality gate and 27 fail-closed `Database service error` diagnostics from read-only release-gate evidence checks. The latter are dependency-unavailable blockers and should not be described as HTTP endpoint tests. The 64 PostgreSQL records contain 46 check-constraint violations, eight unique-constraint violations, eight foreign-key violations, and two not-null violations. The exact source records, including original log line number, job, step, message, and raw line, are retained in [`ci-negative-path-lines-32388405081.json`](./ci-negative-path-lines-32388405081.json).

> A raw `ERROR` count is not a workflow result. The workflow result is determined by process exit codes, job conclusions, unhandled/fatal markers, completion markers, artifact contracts, and integrity checks.

## Evidence and validation matrix

| Evidence | Result | Interpretation |
|---|---|---|
| Skill workflow step count | 26 | All required steps are present and sequential. |
| Edge-case signal coverage | 26/26 | Every step names one or more malformed, missing, duplicate, expired, mismatched, unavailable, unsafe, or otherwise adverse cases. |
| Failure-boundary coverage | 26/26 | Every step defines a reject, block, stop, evidence-only, or fail-closed outcome. |
| Unsafe authority-field review | Pass | The audited workflow preserves `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, and related non-mutation fields. |
| Skill validation | Pass | `quick_validate.py /home/ubuntu/skills/paytray-shadow-review-release-attestation` returned `Skill is valid!`. |
| Exact-log extractor | Pass | Bundled extractor reproduced 164 total error-like lines, 67 route/service negatives, 64 PostgreSQL negatives, and zero process-failure signals. |
| CI workflow result | Pass | Run `32388405081` completed all eight jobs successfully with no failed steps. |

## Complete 26-step error-handling review

The following review is based on the current `SKILL.md` workflow and its referenced contracts. “Pass” means the step has a clear failure boundary and does not allow an engineering artifact or negative-path output to grant authority.

| Step | Workflow responsibility | Error-handling logic reviewed | Verdict |
|---:|---|---|---|
| 1 | Bind evidence | Rejects missing, malformed, uppercase, placeholder, mismatched, or dirty commit/hash inputs and unexpected branches before downstream evidence work. | **Pass — fail closed before evidence composition.** |
| 2 | Inspect queue | Requires the expected six run IDs, shadow status, pending decisions, and reviewer state; inspection must not mutate the queue. | **Pass — missing or unexpected queue state blocks inspection.** |
| 3 | Prepare worksheet | Requires a genuine human decision, exact run ID, allowed decision, reviewed evidence, rationale, and rollback target; prohibits programmatic decisions. | **Pass — incomplete or synthetic human evidence is rejected.** |
| 4 | Validate-only submission | Requires dry-run mode, six unique runs, lowercase commit/hash formats, no placeholders or sensitive keys, and no network requests. Submit mode requires exact expected binding. | **Pass — malformed, duplicated, sensitive, or networked dry-run input blocks.** |
| 5 | Submit with authorization | Requires explicit reviewer confirmation, ephemeral authenticated token, exact binding, HTTPS, and confirmation; unsafe server responses are rejected. | **Pass — network submission is gated by human authorization and response validation.** |
| 6 | Audit results | Requires terminal decisions, reviewer identity, timestamp, evidence reference, rollback acknowledgement, `applied=false`, and `promotionStatus=shadow_only`. | **Pass — non-terminal, unverifiable, or mutation-like results do not clear review.** |
| 7 | Attest four roles | Rejects duplicate/missing roles, expired or mismatched challenges, malformed signatures, fingerprint/commit/artifact mismatch, and unverified identities. | **Pass — cryptographic and identity errors are explicit blockers.** |
| 8 | Run evidence checks | Requires unique roles, exact binding, fresh target/recovery/verifier evidence, and immutable false/read-only fields. | **Pass — stale, incomplete, or unsafe evidence blocks.** |
| 9 | Follow post-attestation gates | Requires authenticated target, Railway, backup/restore, verifier cursor, reconciliation, and guarded worker evidence; disposable evidence remains engineering-only. | **Pass — unavailable target evidence remains blocked/settings-unavailable.** |
| 10 | Validate and deliver | Requires targeted tests, full quality gate, client smoke, whitespace, and skill validation; only code/redacted docs may be committed. | **Pass — incomplete validation or sensitive artifacts stop delivery.** |
| 11 | Harden probes/dry-run | Separates process-only `/livez` from dependency-strict `/readyz`; dry-run remains non-mutating and missing target settings remain blocked. | **Pass — health and deployment checks cannot grant authority.** |
| 12 | Simulate release cycle | Permits deterministic engineering planning only; modeled blocker resolution remains zero without genuine evidence. | **Pass — simulation cannot manufacture clearance.** |
| 13 | Optimize test hotspots | Requires profiling first, preserves negative coverage, crypto and authority assertions, and requires equal-or-better counts plus full validation. | **Pass — performance changes cannot reduce safety coverage.** |
| 14 | Analyze PostgreSQL/recovery | Separates phases, verifies migrations and SHA-256 integrity, classifies bounded negatives, and leaves `withinTarget=null` without a real RTO target. | **Pass — performance evidence cannot become production SLO or release authority.** |
| 15 | Stress recovery/staging bundle | Uses isolated disposable workers, checks per-worker integrity, stops on collisions or integrity failures, and labels bundles evidence-only. | **Pass — worker failure or integrity failure stops aggregation.** |
| 16 | Capture resources/dependencies | Bounds resource telemetry, restricts restore experiments to local disposable mode, validates child-process measurements, audit, lockfile, and read-only safety fields. | **Pass — resource measurements remain diagnostic and cannot clear blockers.** |
| 17 | Attribute database/storage bottlenecks | Restricts telemetry to local disposable recovery, bounds rows/samples/strings, validates required bases and nonnegative metrics, and forbids SLO/authority interpretation. | **Pass — malformed or unbounded telemetry blocks artifact acceptance.** |
| 18 | Establish repeated-run confidence | Requires complete 2–10 repetitions, zero failed/integrity-failed sequences, exact c2/c4/c8 coverage, and labels Student-t intervals as engineering variance. | **Pass — incomplete samples or failed sequences block confidence output.** |
| 19 | Retain CI baselines | Binds reports to `${{ github.sha }}`, requires database/contention telemetry, fingerprints redacted artifacts, and fails unless final status is `verified`. | **Pass — missing observability, integrity, or safety fields fails the job.** |
| 20 | Aggregate wait events | Requires complete verified c2/c4/c8 reports, one commit, bounded labels, worker coverage, and no target-bound RTO or unsafe fields. | **Pass — incomplete or target-bound diagnostic inputs are rejected.** |
| 21 | Analyze wait/throughput scaling | Requires complete verified reports and describes scaling only; rejects target RTO, commit mismatch, incomplete coverage, failed runs, and unsafe authority fields. | **Pass — descriptive telemetry cannot be promoted to causal or release evidence.** |
| 22 | Profile test hotspots | Requires measured profiling before fixture/concurrency/subprocess/crypto changes and preserves counts, isolation, negative paths, authority fields, and no-network guards. | **Pass — optimization cannot trade away contract coverage.** |
| 23 | Package performance workflow | Requires five independent local-disposable repetitions, phase-bound timing, exact commit binding, fingerprints, and false/read-only authority fields. | **Pass — packaged performance evidence remains diagnostic.** |
| 24 | Migrate lint tooling | Restricts commands to PayTray, requires semantic remediation, fresh validation, lockfile/YAML/whitespace checks, and exact artifact binding. | **Pass — scope drift and validation gaps are explicit blockers.** |
| 25 | Run E2E/release notes | Requires fresh disposable PostgreSQL, Base Sepolia, documented fixtures, `chainTransactionSubmitted=false`, and state separation between implemented, verified, evidence, and blocked. | **Pass — route/client evidence cannot be misrepresented as settlement.** |
| 26 | Staging compatibility dry-run | Uses safe staging/Base Sepolia flags; accepts `settings_unavailable` without target evidence and requires no network/deployment/mutation plus false authority fields. | **Pass — absent Railway or target evidence remains fail-closed.** |

## Exact CI taxonomy for run 32388405081

The extractor used the following mutually exclusive precedence: route/service-negative, PostgreSQL constraint-negative, expected test stderr, expected artifact/status, process-failure signal, then unclassified error-like output. This precedence is important because deliberate negative tests contain words such as `ERROR`, `failure`, or `exception`.

| Category | Count | Exact message-level breakdown | Main job/step attribution |
|---|---:|---|---|
| Route/service negatives | 67 | 40 structured `ErrorHandler` logs; 27 `Database service error / unavailable dependency` diagnostics. | 60 shared quality-gate lines; 7 read-only release-gate evidence lines. |
| PostgreSQL constraint negatives | 64 | 46 CHECK; 8 unique; 8 foreign-key; 2 NOT NULL. | 32 isolated PostgreSQL route-contract cleanup lines; 32 disposable backup/recovery cleanup lines. |
| Expected test stderr | 1 | One diagnostic stderr record. | Shared quality gate. |
| Expected artifact/status | 5 | Two restored ready-PostgreSQL records; one restored operations-quality record; two reviewer-attestation transaction-race records. | Recovery and isolated route contract jobs. |
| Other error-like | 27 | Informational/configuration or artifact-context lines not matched to a stronger category. | Mainly shared quality, release-gate, and artifact-upload steps. |
| Process failure | 0 | No non-zero process exit, failed job, `Unhandled`, or `FATAL` marker. | None. |
| **Total error-like** | **164** | **All categories above.** | **Eight successful jobs.** |

### Route/service-negative records

The 40 structured route records were emitted by the shared quality gate’s deliberate negative-path tests. The retained records include examples such as:

```text
log line 2895: {"level":"ERROR","context":"ErrorHandler","message":"POST /api/auth/login","data":{"error":"Signature verification failed: invalid raw signature length ..."}}
log line 2911: {"level":"ERROR","context":"ErrorHandler","message":"GET /api/users/me","data":{"error":"Access token required"}}
log line 2924: {"level":"ERROR","context":"ErrorHandler","message":"POST /api/auth/login","data":{"error":"Auth challenge is invalid or expired"}}
log line 2936: {"level":"ERROR","context":"ErrorHandler","message":"GET /api/ops/slo","data":{"error":"Missing required scopes: ops:*"}}
```

The remaining 27 records are fail-closed dependency diagnostics emitted while the read-only release-gate job attempted evidence checks without a running database service. Representative records include:

```text
log line 2124: "reason": "Database service error: connect ECONNREFUSED 127.0.0.1:5432"
log line 2260: "reason": "Database service error: connect ECONNREFUSED 127.0.0.1:5432"
log line 2366: "reason": "Database service error: connect ECONNREFUSED 127.0.0.1:5432"
```

These 27 lines are **not** successful target evidence and are **not** route-level acceptance tests. They demonstrate that read-only evidence checks remain blocked when their dependency is unavailable. The audit intentionally preserves this distinction while retaining the historical aggregate category used by the CI taxonomy.

### PostgreSQL constraint-negative records

The 64 PostgreSQL records were emitted during cleanup of isolated contract jobs. The 32 records from the isolated PostgreSQL route contract cover invalid `operations_quality_runs` status/report values, duplicate run identifiers, and invalid verified-trust-signal foreign keys. Representative source lines include:

```text
log line 5243: new row for relation "operations_quality_runs" violates check constraint "operations_quality_runs_status_check"
log line 5270: new row for relation "operations_quality_runs" violates check constraint "operations_quality_runs_report_check"
log line 5324: duplicate key value violates unique constraint "operations_quality_runs_run_id_key"
log line 5333: insert or update on table "verified_trust_signals" violates foreign key constraint "verified_trust_signals_subject_user_id_fkey"
```

The second set of 32 records was emitted by the disposable backup and isolated recovery contract while exercising equivalent migration and integrity constraints against the restored database. The exact remaining records are retained without rewriting in the JSON artifact.

A PostgreSQL constraint error is expected only when the owning test deliberately submits invalid data and subsequently asserts the rejection. It does not, by itself, prove migration completeness or recovery integrity. The surrounding job’s successful completion, migration verification, restored-contract assertions, and artifact checks are required for the overall job to pass.

## Reusable implementation added

The skill now includes [`scripts/extract-ci-negative-lines.mjs`](../skills/paytray-shadow-review-release-attestation/scripts/extract-ci-negative-lines.mjs) and [`references/ci-negative-path-taxonomy.md`](../skills/paytray-shadow-review-release-attestation/references/ci-negative-path-taxonomy.md). The extractor accepts a complete log path, run ID, commit binding, output path, and optional expected counts. It preserves exact source lines and exits non-zero when a supplied expected count differs or any process-failure signal is found.

The skill navigation in `SKILL.md` now directs future agents to this reference whenever exact source lines must be retained. The current implementation was run against the complete run `32388405081` log and reproduced the known 67/64/0 result. The package validator returned `Skill is valid!`.

## Residual boundaries

This audit does not clear any human shadow review, four-role sign-off, Ed25519 custody requirement, Railway target evidence, verifier cursor, deployment gate, release authority, or settlement authority. The run is engineering evidence only. The repository must continue to report `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `applied=false`, `deploymentPerformed=false`, and `settlementMutationPerformed=false` until genuine protected evidence and human decisions are independently supplied.

## References

[1]: https://github.com/OxCryptobot/PAYTRAY/actions/runs/32388405081 "PayTray CI run 32388405081"
[2]: https://github.com/OxCryptobot/PAYTRAY "PayTray repository"
