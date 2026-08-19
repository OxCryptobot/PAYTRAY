# Resource Telemetry and Lockfile-Drift Enforcement Batch Plan

## Objective

Improve PayTray’s recovery engineering evidence and dependency integrity without changing payment authority, verifier ownership, AI promotion, human-review, or release-gate semantics. The batch is intentionally read-only with respect to release authority: it may measure disposable recovery work and reject dependency drift, but it must never grant `releaseEligible`, settlement authority, or deployment authorization.

## Current batch implementation

The implementation in progress adds three bounded capabilities.

| Capability | Implementation | Safety boundary |
|---|---|---|
| Recovery resource telemetry | `recoveryResourceTelemetry.js` captures Node process CPU time, RSS/heap memory, filesystem-operation counts, and context switches for each recovery subprocess and measured phase. | Engineering observation only; `basis=node_process_resource_usage`; no production SLO or settlement use. |
| Resource schema validation | `verify-recovery-artifact.mjs` validates optional resource blocks and rejects missing, negative, or malformed metrics. | Earlier artifacts without resource telemetry remain compatible; new malformed telemetry blocks verification. |
| Lockfile-drift enforcement | `verify-lockfile-drift.mjs` compares the root workspace list, lockfile version, workspace names/versions, direct dependency declarations, and resolved package entries. | Read-only; emits a stable SHA-256 fingerprint and retains false/read-only safety fields. |

The root command is `npm run backend:dependencies:lockfile:check`. CI runs the high-severity audit and lockfile-drift check immediately after `npm ci`, before the shared quality gate.

## Phase 1 — Contract and baseline

Record the exact candidate commit, Node/npm versions, lockfile version, workspace manifests, dependency tree, audit result, and current six-job CI durations. The baseline must include the current recovery stress reports at concurrency 2, 4, and 8 and identify restore as the dominant phase. No baseline may include credentials, raw user data, private keys, or human-review decisions.

**Exit criteria:** a reproducible lockfile, clean workspace manifest alignment, a zero-or-explicitly-accepted audit inventory, and a redacted baseline artifact fingerprint.

## Phase 2 — Resource telemetry instrumentation

Capture process-level resource usage inside the recovery subprocess rather than inferring child-process usage from the parent. Record CPU microseconds, RSS and heap bytes, peak RSS, filesystem-operation counts, and context-switch counts. Attach the measurements to the existing phase-bound timing envelope, retaining backup, backup-integrity, catalog, restore, and restore-verification phase names.

The schema must require nonnegative safe integers and an explicit `basis`. Missing resource blocks may remain valid for historical artifacts, but when present they must contain a process sample and phase samples with the complete metric set. Resource telemetry must remain redacted and must never contain database credentials, file contents, dump bytes, or query text.

**Exit criteria:** focused helper tests, recovery stress aggregation tests, artifact-validation tests, and one disposable end-to-end run that emits resource telemetry with zero integrity failures.

## Phase 3 — Lockfile-drift enforcement

The verifier must compare `package.json` and `package-lock.json` without mutating either file. It should check:

1. `lockfileVersion` remains the repository-supported version.
2. Root workspace declarations match the lockfile workspace declarations.
3. Each workspace name and version matches its lockfile entry.
4. Every direct dependency, dev dependency, optional dependency, and peer dependency declaration matches the lockfile entry.
5. Every declared non-peer package has a resolved package entry.
6. The report contains a stable `paytray_lockfile_drift_v1` SHA-256 fingerprint.
7. The report remains `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.

CI should run the verifier after `npm ci` and before tests. A mismatch must fail the job; the verifier must not run `npm install`, `npm audit fix`, or any other mutation.

**Exit criteria:** current repository verification passes; a fixture with a changed dependency range blocks; a missing package entry blocks; a fingerprint is deterministic; and the full CI job fails closed on an intentional drift test.

## Phase 4 — Recovery resource analysis

Run bounded disposable recovery at concurrency 2, 4, and 8 using isolated source and restore databases. Report throughput, p50/p95/p99/max recovery latency, phase latency, CPU, RSS, filesystem-operation counts, and context-switch totals. Keep `withinTarget=null` unless `RECOVERY_RTO_TARGET_MS` is explicitly supplied.

The current measurements show increasing throughput but diminishing per-worker gains and increasing tail latency. Restore is the first optimization target. Before testing concurrency 16 or higher, add resource telemetry for PostgreSQL I/O, temporary-storage throughput, database connection waits, `pg_restore` process time, and peak RSS on an explicitly provisioned disposable host.

**Exit criteria:** zero failed sequences, zero integrity failures, exactly 19 migrations restored, no worker database collision, stable repeated percentiles, and a clear statement that local measurements are not production RTO or capacity evidence.

## Phase 5 — Operational rollout and regression gates

Every dependency or telemetry change must pass the focused tests, full backend quality gate, ESLint, extension and SDK contracts, client smoke E2E, fresh high-severity audit, lockfile verifier, PostgreSQL route contract, recovery contract, container health contract, and read-only release-gate inspection. Compare test counts, job durations, warning counts, and safety fields with the baseline.

The batch remains separate from target evidence and human evidence. It does not clear Railway settings, target backup/restore, verifier cursor, reconciliation, six shadow reviews, four sign-offs, Ed25519 custody, release approval, or production deployment.

## Recommended follow-up work

| Priority | Follow-up | Rationale |
|---|---|---|
| P0 | Keep the high-severity audit and lockfile verifier in CI. | Prevents recurrence of the seven-finding dependency state and catches unreviewed drift. |
| P1 | Add lockfile-diff review output with a categorized runtime/dev dependency summary. | Helps reviewers distinguish payment-path changes from test-tool changes. |
| P1 | Add PostgreSQL and filesystem resource counters to recovery runs. | Identifies whether restore contention is storage, CPU, connection, or database-level wait pressure. |
| P1 | Repeat concurrency 2/4/8 runs enough to establish stable percentile confidence intervals. | One run per level is insufficient for production capacity claims. |
| P2 | Evaluate bounded `pg_restore` parallelism on disposable infrastructure. | Restore is the dominant phase, but optimization must preserve exact migration and integrity checks. |

## Safety invariants

The following fields must remain unchanged in every batch report:

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false
}
```

A green dependency, telemetry, or stress check is engineering evidence only. It does not establish target readiness, human approval, operator-key custody, economic truth, or controlled release authority.
