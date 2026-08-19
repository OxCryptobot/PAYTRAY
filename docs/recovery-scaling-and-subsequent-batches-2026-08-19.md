# Recovery Scaling Comparison and Subsequent Engineering Batches

## Scope and evidence boundary

This report compares fresh disposable PostgreSQL recovery runs for commit `f488f6db0d77a0414c6061f7a1b3e50ca08be105` at concurrency 2, 4, and 8. Each worker used an isolated source/restore database, verified the restored schema and 19 migrations, and cleaned up its disposable resources. All three levels completed successfully with zero failed sequences and zero integrity failures.

These observations are engineering evidence from `environment=local_disposable`. They are not production capacity, target-environment RTO, or release-authority evidence. No `RECOVERY_RTO_TARGET_MS` was configured, so `withinTarget=null` at every level.

## Fresh performance comparison

| Concurrency | Orchestration wall time | Throughput | Sequence p50 | Sequence p95 | Sequence p99 | Max sequence | Restore p95 | Peak RSS | Max heap used |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 461 ms | 4.338/s | 238.0 ms | 241.6 ms | 241.92 ms | 242 ms | 120.95 ms | 57,908 KiB | 7,097,984 B |
| 4 | 452 ms | 8.850/s | 261.0 ms | 266.4 ms | 266.88 ms | 267 ms | 150.55 ms | 58,284 KiB | 7,079,400 B |
| 8 | 657 ms | 12.177/s | 370.5 ms | 391.75 ms | 395.95 ms | 397 ms | 252.65 ms | 59,116 KiB | 7,067,328 B |

The current run shows increasing useful parallelism with a clear tail-latency cost. Throughput grows **180.71%** from concurrency 2 to 8, while p99 sequence latency grows **63.67%**. Restore p95 grows **108.89%**, making restore contention the primary optimization target. Peak RSS grows only **2.09%** from 57,908 KiB to 59,116 KiB, and maximum heap usage is effectively flat and slightly lower at concurrency 8. This means the observed constraint is more consistent with restore/database/storage contention than with Node heap growth, although PostgreSQL and temporary-storage counters are still needed before attributing the cause conclusively.

### Adjacent scaling behavior

| Transition | Throughput change | Added-worker throughput | p95 sequence change | p99 sequence change | Peak RSS change | Interpretation |
|---|---:|---:|---:|---:|---:|---|
| 2 → 4 | +104.0% | 2.256/s per added worker | +10.33% | +10.33% | +0.65% | Strong parallel gain with modest latency cost. |
| 4 → 8 | +37.59% | 0.832/s per added worker | +47.05% | +48.36% | +1.43% | Diminishing throughput returns and materially worse tail latency. |

### Phase behavior

| Phase | p95 at c2 | p95 at c4 | p95 at c8 | c2 → c8 change | Finding |
|---|---:|---:|---:|---:|---|
| Backup | 86.65 ms | 77.85 ms | 119.90 ms | +38.38% | Storage and dump concurrency may contribute at c8. |
| Backup integrity | 1.95 ms | 2.85 ms | 4.30 ms | +120.51% | Hashing remains small in absolute terms but becomes more variable. |
| Catalog | 19.95 ms | 26.40 ms | 30.90 ms | +54.89% | Restore catalog inspection shows moderate contention. |
| Restore | 120.95 ms | 150.55 ms | 252.65 ms | +108.89% | Dominant bottleneck and first optimization target. |
| Restore verification | 12.95 ms | 16.85 ms | 22.65 ms | +74.90% | Verification rises with database contention but remains secondary. |

## Resource footprint comparison

The aggregate resource telemetry reports the following totals for the worker subprocesses:

| Concurrency | User CPU total | System CPU total | Voluntary context switches | Involuntary context switches | Peak RSS |
|---:|---:|---:|---:|---:|---:|
| 2 | 37,777 μs | 8,176 μs | 99 | 0 | 57,908 KiB |
| 4 | 72,528 μs | 16,789 μs | 196 | 25 | 58,284 KiB |
| 8 | 163,202 μs | 25,514 μs | 435 | 186 | 59,116 KiB |

CPU and context-switch totals rise faster than concurrency, especially from 4 to 8 workers. RSS remains comparatively flat because each worker is a short-lived subprocess with a similar Node footprint. The next measurement must include PostgreSQL CPU, disk I/O, temporary-directory bytes, database connection waits, and `pg_restore` process timing; the current Node-level telemetry cannot distinguish database or storage saturation.

## Subsequent engineering batch milestones

### Batch 1 — Repeatable baseline and evidence gate

**Status:** implemented in the current working batch. `verify-recovery-stress-baseline.mjs` validates exact 2/4/8 coverage, commit binding, local-disposable scope, zero failures, zero integrity failures, null RTO semantics, optional resource telemetry, and immutable safety fields. The command is `npm run backend:recovery:stress:baseline:check`.

**Milestone:** run the verifier against fresh c2/c4/c8 reports, produce a stable `paytray_recovery_stress_baseline_v1` SHA-256 fingerprint, and retain the redacted reports. The current verified fingerprint is `54119b003940eac2d4248949a04fc6be2e79baf4d8cc7ae36ab4bb42f4bec46c`.

### Batch 2 — Database and storage resource attribution

Add PostgreSQL-side and filesystem-side measurements to the disposable harness: `pg_stat_activity` wait events, connection acquisition time, database size before/after, temporary backup bytes, `pg_dump`/`pg_restore` subprocess timing, and storage read/write throughput. Keep all measurements bounded and redacted.

**Milestone:** identify whether the c4→c8 restore p95 increase is associated with database waits, connection pressure, temporary-storage throughput, or restore process CPU. Acceptance requires zero integrity failures, no cross-worker collisions, and unchanged migration count.

### Batch 3 — Restore optimization experiment

Evaluate bounded `pg_restore` parallelism only on disposable infrastructure. Compare serial restore with explicitly bounded `--jobs` settings, retaining one isolated restore database per worker. Do not change production defaults until repeated runs show a latency improvement without increased errors or resource exhaustion.

**Milestone:** achieve a statistically repeatable restore p95 improvement at c8 or document that the workload is storage/DB-bound and parallel restore is not beneficial. All reports must continue to use `withinTarget=null` without an operator target.

### Batch 4 — Repeated-run confidence and regression thresholds

Run multiple independent repetitions at c2, c4, and c8 and compute confidence intervals or robust dispersion metrics. Establish engineering-only warning thresholds for p95/p99 growth, peak RSS, CPU per sequence, and integrity failures. The thresholds must be reviewable configuration, not hidden release-authority logic.

**Milestone:** publish a baseline envelope with repeated-run counts and variance. Block the batch on any integrity failure or unexplained worker collision; do not convert the envelope into a production SLO without an explicit operator-approved contract.

### Batch 5 — CI artifact and observability integration

Upload redacted baseline reports, resource summaries, and fingerprints from a disposable CI job. Add artifact retention and a read-only comparison step. Keep the six-job workflow fail-closed on test, integrity, audit, lockfile, and schema failures, while keeping performance comparisons informational unless a separately approved threshold contract exists.

**Milestone:** every CI baseline artifact is bound to the exact commit, has a sidecar SHA-256, contains no credentials or raw data, and preserves `releaseEligible=false` and `settlementAuthority=false`.

## Safety invariants

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false,
  "withinTarget": null
}
```

No human review decisions, operator signing keys, target settings, Railway configuration, production deployment, live funds, mainnet transactions, or real user data were used or inferred.
