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

**Status:** implemented in the current working batch. `recoveryDatabaseTelemetry.js` captures bounded `pg_stat_activity` wait-event groups, connection-acquisition percentiles, `pg_stat_database` temporary-byte/file and block deltas, and redacted database-size snapshots. `verify-recovery-evidence.mjs` optionally emits this block when `RECOVERY_CAPTURE_DATABASE_TELEMETRY=true`, measures `pg_dump`/`pg_restore` child resources when enabled, and emits bounded backup-file bytes/write throughput. `verify-recovery-artifact.mjs` validates the new `postgresql_observability` and `local_disposable_backup_file` contracts. These measurements remain engineering-only and preserve all false/read-only safety fields.

Enable the batch only for an isolated local disposable run:

```bash
RECOVERY_CAPTURE_DATABASE_TELEMETRY=true \\
RECOVERY_DATABASE_TELEMETRY_INTERVAL_MS=25 \\
RECOVERY_DATABASE_TELEMETRY_MAX_SAMPLES=120 \\
RECOVERY_STRESS_ENVIRONMENT=local_disposable \\
RECOVERY_STRESS_RELEASE_COMMIT=<40-hex-commit> \\
RECOVERY_STRESS_ADMIN_URL=postgresql://...@127.0.0.1:5432/postgres \\
RECOVERY_STRESS_CONCURRENCY=8 \\
npm run backend:recovery:stress
```

Add PostgreSQL-side and filesystem-side measurements to the disposable harness: `pg_stat_activity` wait events, connection acquisition time, database size before/after, temporary backup bytes, `pg_dump`/`pg_restore` subprocess timing, and storage read/write throughput. Keep all measurements bounded and redacted.

**Milestone:** identify whether the c4→c8 restore p95 increase is associated with database waits, connection pressure, temporary-storage throughput, or restore process CPU. Acceptance requires zero integrity failures, no cross-worker collisions, and unchanged migration count.

### Batch 3 — Restore optimization experiment

Evaluate bounded `pg_restore` parallelism only on disposable infrastructure. Compare serial restore with explicitly bounded `--jobs` settings, retaining one isolated restore database per worker. Do not change production defaults until repeated runs show a latency improvement without increased errors or resource exhaustion.

**Milestone:** achieve a statistically repeatable restore p95 improvement at c8 or document that the workload is storage/DB-bound and parallel restore is not beneficial. All reports must continue to use `withinTarget=null` without an operator target.

### Batch 4 — Repeated-run confidence and regression thresholds

**Status:** runner and aggregation contract implemented in the current working batch. `repeat-recovery-stress.mjs` executes real local-disposable c2/c4/c8 repetitions, requires exact concurrency coverage, aggregates p95/p99, restore p95, throughput, RSS, CPU, database temporary bytes, and connection-acquisition metrics, and reports two-sided Student-t 95% intervals for the bounded sample sizes. It stops on the first failed or integrity-blocked run, emits a stable SHA-256 fingerprint, and preserves `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.

Run it only with authenticated local-disposable PostgreSQL configuration:

```bash
RECOVERY_STRESS_ENVIRONMENT=local_disposable \\
RECOVERY_STRESS_RELEASE_COMMIT=<40-hex-commit> \\
RECOVERY_STRESS_ADMIN_URL=postgresql://...@127.0.0.1:5432/postgres \\
RECOVERY_STRESS_REPETITIONS=3 \\
RECOVERY_STRESS_REPEAT_CONCURRENCIES=2,4,8 \\
RECOVERY_CAPTURE_DATABASE_TELEMETRY=true \\
npm run backend:recovery:stress:repeat
```

Run multiple independent repetitions at c2, c4, and c8 and compute confidence intervals or robust dispersion metrics. Establish engineering-only warning thresholds for p95/p99 growth, peak RSS, CPU per sequence, and integrity failures. The thresholds must be reviewable configuration, not hidden release-authority logic.

**Milestone:** publish a baseline envelope with repeated-run counts and variance. Block the batch on any integrity failure or unexplained worker collision; do not convert the envelope into a production SLO without an explicit operator-approved contract.

### Batch 5 — CI artifact and observability integration

**Status:** implemented in the current working batch. The GitHub Actions workflow now includes a disposable PostgreSQL `recovery-baseline` job that runs real c2/c4/c8 stress with `RECOVERY_CAPTURE_DATABASE_TELEMETRY=true` and `RECOVERY_CAPTURE_CHILD_RESOURCE=true`. It writes redacted per-level JSON reports, validates exact commit binding and required `postgresql_observability`/`local_disposable_backup_file` blocks, fingerprints all reports with a SHA-256 sidecar, retains artifacts for seven days, and fails the job unless the baseline verifier emits `status=verified`.

The baseline verifier now supports `RECOVERY_STRESS_REQUIRE_DATABASE_TELEMETRY=true`. In that mode it requires one database summary and one storage/telemetry record per worker, at least two database samples per worker, bounded wait-event observations, nonnegative connection metrics, empty error arrays, and immutable false/read-only fields. The c8 artifacts currently saved before this CI job was added remain Node/resource-only; a fresh CI run is required before interpreting actual c8 wait-event or connection-containment values.

**Milestone:** every CI baseline artifact is bound to the exact commit, has a sidecar SHA-256, contains no credentials or raw data, and preserves `releaseEligible=false` and `settlementAuthority=false`.

### Batch 6 — Read-only wait-event distribution comparison

**Status:** implemented in the current working batch. The repository now exposes `backend:recovery:stress:wait-events:check`, which aggregates verified c2/c4/c8 wait-event labels, observed backend counts, worker coverage, connection-acquisition maxima, temporary-byte/file deltas, and recovery elapsed summaries. It binds every input to one exact commit, rejects target-bound RTO reports and unsafe authority fields, rejects malformed or oversized wait labels, fingerprints the read-only output, and emits no raw database content.

The disposable CI baseline job now runs this aggregation after baseline verification, includes the resulting JSON in the SHA-256 sidecar, uploads it with the redacted c2/c4/c8 artifacts, and fails closed unless both the baseline and distribution reports are `status=verified`. The distribution is diagnostic only; it cannot establish causal attribution, production SLOs, release eligibility, payment state, or settlement authority.

### Batch 7 — Sustained-concurrency wait-signal and throughput analysis

**Status:** implemented in the current working batch. The repository now exposes `backend:recovery:stress:wait-throughput:check`, which derives completed recovery sequences per second from `completedSequences / orchestrationElapsedMs` and compares DataFileImmediateSync and LWLock/WALWrite observations per 100 PostgreSQL samples across c2/c4/c8. It reports worker coverage, restore and sequence percentiles, connection-acquisition maxima, throughput change between levels, and efficiency versus linear scaling.

The analyzer explicitly labels its output `descriptive_only` because the recovery harness does not measure application transaction TPS and sampled `pg_stat_activity` wait events are not causal attribution. It rejects target-bound RTO reports, commit mismatches, incomplete or failed levels, integrity failures, and unsafe authority fields. CI now fingerprints, uploads, and requires the new throughput artifact alongside the existing baseline and wait-event artifacts.

### Batch 8 — Repeated confidence, contention depth, and profile-first optimization

**Status:** implemented locally and ready for full validation. The repeated runner now supports strict `RECOVERY_STRESS_REQUIRE_CONTENTION_TELEMETRY=true` mode and summarizes Student-t confidence intervals for pool waiting/utilization, WAL records/bytes/write/sync timing, backend fsync counters, temporary storage, connection acquisition, recovery tails, CPU, and RSS. A guarded local-disposable run completed three independent repetitions at c2/c4/c8: nine verified runs, zero failed sequences, zero integrity failures, null-target RTO semantics, and `contentionTelemetry=true`.

The PostgreSQL helper now captures bounded pool pressure (`totalCount`, `activeCount`, `idleCount`, `waitingCount`, utilization), `pg_stat_wal` counters, and `pg_stat_bgwriter` checkpoint/backend-fsync counters. The baseline verifier supports strict fail-closed validation for these blocks, and the recovery-baseline workflow requires them. A dependent `recovery-confidence` CI job runs three repetitions across c2/c4/c8, requires Student-t output and false/read-only safety fields, fingerprints the redacted report, and retains it for seven days.

The new `backend:tests:profile:recovery-postgres` command profiled the recovery and PostgreSQL contract suites without changing fixtures or behavior. The current hotspots are `recoveryStressBaseline.test.js` at approximately 30.3 ms and `recoveryArtifactTiming.test.js` at approximately 14.9 ms in the measured local run; these are engineering targets only, not production capacity or SLO evidence.

### Batch 9 — Higher-resolution WAL/fsync timing and five-repetition confidence

**Status:** implemented locally; five-repetition evidence completed against exact commit `7d623a7`. The PostgreSQL collector now captures phase-bound snapshot-query duration and PostgreSQL 16 `pg_stat_io` read/write/extend/fsync counters and timing, in addition to the existing pool-pressure, `pg_stat_wal`, and `pg_stat_bgwriter` blocks. Strict baseline and repeated-confidence validation requires `basis=pg_stat_io`, nonnegative counter deltas, and complete snapshot timing summaries.

The guarded local-disposable run completed **15 verified runs**: five independent repetitions each at c2, c4, and c8, with zero failed sequences, zero integrity failures, null-target RTO semantics, and `contentionTelemetry=true`. Five-run two-sided Student-t intervals are materially narrower than the earlier three-run evidence for the same local setup. At c8, mean derived recovery throughput was 7.092 sequences/second with a 95% interval of [6.680, 7.504], mean sequence p95 was 841.99 ms with [776.319, 907.661], and mean snapshot-query maximum was 6.231 ms with [5.194, 7.267]. Pool waiting remained zero, while pg_stat_io fsync/write timing counters remained zero in the sampled environment and are retained as observations rather than interpreted as proof of absent physical fsync cost.

The existing disposable CI `recovery-baseline` and dependent `recovery-confidence` jobs inherit the stricter contract through `RECOVERY_STRESS_REQUIRE_CONTENTION_TELEMETRY=true`; the next pushed CI run must verify the new pg_stat_io and snapshot-timing fields before the batch is considered complete.

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

### Batch 10 — ESLint v9 migration

**Status:** queued for a separate toolchain batch. The current batch deliberately avoids changing the lint major version while extending recovery evidence, so the existing clean ESLint contract remains stable. The migration must preserve flat-config coverage, test counts, CI parity, and fail-closed release checks before it is pushed.

### Batch 11 — Five-repetition confidence CI integration

**Status:** implemented locally in the current batch. The `recovery-confidence` GitHub Actions job now runs five independent c2/c4/c8 repetitions instead of three, retains the Student-t confidence artifact and log, and continues to require verified status, contention telemetry, and immutable false/read-only authority fields. A fresh pushed CI run remains the authoritative verification of the updated workflow.

### Batch 12 — Phase-bound WAL/fsync timing and counter analysis

**Status:** implemented locally in the current batch. Recovery PostgreSQL telemetry now emits `phaseBoundWriteSyncTiming` for the restore window, derived from the first and last `pg_stat_wal`/`pg_stat_io` snapshots and explicitly marked as diagnostic rather than physical-fsync proof. The baseline verifier and strict repeated-confidence validator require the block, and `backend:recovery:stress:db-counters:check` produces a commit-bound c2/c4/c8 comparison artifact with WAL, pg_stat_io, snapshot-query, and grouped wait-event summaries. A real local-disposable c2/c4/c8 run on the current working tree completed with zero failures and generated a SHA-256 sidecar; CI must verify the same contract after push.

The new timing fields do not alter RTO, settlement, release, or payment authority. They remain engineering evidence only and preserve the safety invariant block below.
