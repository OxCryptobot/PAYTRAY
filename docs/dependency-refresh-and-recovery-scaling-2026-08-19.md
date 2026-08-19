# Dependency Refresh and Recovery Scaling Batch — 2026-08-19

## Scope

This batch reviewed the seven npm audit findings recorded before the dependency refresh and analyzed the disposable PostgreSQL recovery harness at concurrency levels 2, 4, and 8. The batch preserved PayTray’s fail-closed payment, verifier, AI shadow-only, human-review, and release-authority boundaries. It did not clear target-environment blockers or grant deployment or settlement authority.

## Vulnerability inventory and remediation

The pre-refresh audit reported two moderate, four high, and one critical vulnerability across seven package nodes. The direct runtime package was `ethers@6.10.0`; the direct development package was `vitest@1.6.1`. The remaining findings were transitive packages in the test/build chain or the ethers WebSocket dependency.

| Package | Installed before | Severity | Advisory | Remediation | Result |
|---|---:|---|---|---|---|
| `vitest` | 1.6.1 | Critical | [GHSA-5xrq-8626-4rwp][1] | Upgrade to patched `3.2.6`; do not expose Vitest UI or browser APIs to untrusted networks. | Fixed; post-refresh audit clean. |
| `vite` | 5.4.21 | High plus moderate advisories | [npm audit JSON][5] | Refreshed by Vitest 3.2.6 to `7.3.6`, which is outside the old Vite line but passed the complete test and contract suite. | Fixed; compatibility validated. |
| `vite-node` | 1.6.1 | Moderate | [npm audit JSON][5] | Refreshed to `3.2.4` by Vitest 3.2.6. | Fixed; compatibility validated. |
| `esbuild` | 0.21.5 | Moderate | [GHSA-67mh-4wv8-2f99][2] | Refreshed transitively to `0.28.2`; avoid exposing development servers with broad CORS. | Fixed; post-refresh audit clean. |
| `nanoid` | 3.3.16 in the pre-refresh lockfile | High | [GHSA-2v37-7h3g-55p8][3] | Refreshed transitively to a patched 3.x version through the updated build chain. | Fixed; post-refresh audit clean. |
| `ws` | 8.5.0 | High | [GHSA-3h5v-q93c-6h6q][4] | Refreshed through `ethers@6.17.0` to `ws@8.21.0`. | Fixed; post-refresh audit clean. |
| `ethers` | 6.10.0 | High through `ws` | [npm audit JSON][5] | Direct exact-version upgrade to `6.17.0`; this is a non-major ethers update and was regression-tested across payment contracts. | Fixed; compatibility validated. |

The critical Vitest advisory affects the Vitest UI or Browser Mode when exposed beyond localhost, and patched versions include `3.2.6` and `4.1.0`.[1] PayTray does not expose a Vitest UI command in its backend manifest, but leaving a critical vulnerable test tool in the lockfile was not acceptable. The chosen 3.2.6 upgrade was the smallest patched line compatible with the repository’s Node 22 runtime and did not require the forced Vitest 4 major upgrade reported by npm.

The `ws` advisory is fixed in `8.17.1` and later.[4] Updating ethers to `6.17.0` moved the resolved ws dependency to `8.21.0` without introducing a major ethers drift. The nanoid advisory is fixed in `3.3.18` and later for the 3.x line.[3] The refreshed dependency graph resolved the vulnerable node and the fresh audit reported zero vulnerabilities.

## Validation results

The dependency refresh modified `packages/backend/package.json` and the root lockfile. It was applied without `npm audit fix --force`. The following validation passed:

| Validation | Result |
|---|---|
| Focused recovery-stress tests | 3 tests passed under Vitest 3.2.6. |
| Full backend quality gate | 92 test files and 402 tests passed. |
| ESLint | Clean. |
| Extension contract | Passed. |
| SDK contract | Passed. |
| Client smoke E2E | Passed with dynamic port isolation. |
| Fresh npm audit | 0 vulnerabilities: 0 moderate, 0 high, 0 critical. |
| Dependency tree | `ethers@6.17.0`, `ws@8.21.0`, `vitest@3.2.6`, `vite-node@3.2.4`, `vite@7.3.6`, `esbuild@0.28.2`. |

The next required step is the six-job GitHub Actions run for the dependency-refresh commit. The dependency batch must remain separate from target evidence, human review, signing-key custody, and deployment changes.

## Recovery scaling analysis

All three runs used disposable local PostgreSQL source and worker-scoped restore databases. Every sequence completed with status `verified`, zero failures, zero integrity failures, and `withinTarget=null` because no operator RTO target was configured.

| Concurrency | Throughput | Sequence p50 | Sequence p95 | Sequence p99 | Max | Dominant phase mean |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 5.063/sec | 224.5 ms | 225.85 ms | 225.97 ms | 226 ms | Restore, 117.5 ms |
| 4 | 8.639/sec | 274.5 ms | 284.4 ms | 284.88 ms | 285 ms | Restore, 160.25 ms |
| 8 | 12.214/sec | 358.5 ms | 403 ms | 419.8 ms | 424 ms | Restore, 221.38 ms |

Relative to concurrency 2, concurrency 4 increased throughput by 70.63% while p95 increased 25.92%. Concurrency 8 increased throughput by 141.24% while p95 increased 78.44%, p99 increased 85.78%, and maximum latency increased 87.61%. The additional 4-to-8 worker step delivered a 41.38% throughput increase over concurrency 4, but added 118.6 ms to p95 and 134.92 ms to p99. This is useful parallelism with a growing tail-latency cost, not evidence of linear scalability.

Restore is the dominant phase at every tested concurrency. Its mean grew from 117.5 ms at concurrency 2 to 221.38 ms at concurrency 8. Backup was the second-largest phase, growing from 71.5 ms to 93.63 ms. Backup-integrity hashing, catalog inspection, and restore verification remained smaller. The next performance batch should profile database I/O, `pg_restore` parallelization options, temporary-storage throughput, and connection/CPU pressure on a provisioned disposable host before changing recovery semantics.

These results do not establish a production RTO, capacity ceiling, or safe production worker count. Run higher concurrency only with explicit disposable resource limits, repeat the test enough to stabilize percentiles, and supply an operator RTO target separately when an actual target comparison is required.

## Immutable safety status

Every engineering report in this batch retains `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `deploymentPerformed=false`, and `settlementMutationPerformed=false`. Dependency remediation and local recovery stress are engineering-quality work; they do not clear Railway, recovery-target, verifier, human-review, Ed25519 custody, or release-approval blockers.

## References

[1]: https://github.com/advisories/GHSA-5xrq-8626-4rwp "Vitest critical UI server advisory"
[2]: https://github.com/advisories/GHSA-67mh-4wv8-2f99 "esbuild development-server CORS advisory"
[3]: https://github.com/advisories/GHSA-2v37-7h3g-55p8 "nanoid zero-size infinite-loop advisory"
[4]: https://github.com/websockets/ws/security/advisories/GHSA-3h5v-q93c-6h6q "ws many-header DoS advisory"
[5]: ../tmp/paytray-deliverables/paytray-5576f97-recovery-stress-npm-audit.json "Captured npm audit JSON"
