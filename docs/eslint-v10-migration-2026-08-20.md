# PayTray ESLint v9/v10 Migration Analysis

## Decision

The repository should **not** ship an ESLint v9-only migration. ESLint’s official release documentation states that ESLint v9 reached end-of-life on **2026-08-06**; the live npm registry currently identifies ESLint 10.8.1 as the latest release. The best-in-class path is therefore a direct migration from ESLint 8.57.1 to ESLint 10.8.1 with flat config. ESLint v9 breaking changes remain relevant because v10 retains the flat-config model and the v9 rule-behavior changes are part of the compatibility surface.

The repository’s CI workflow and production container already use Node 22. ESLint 10.8.1 declares support for Node `^20.19.0 || ^22.13.0 || >=24`; the current Node 22.13.0 environment satisfies that tooling requirement. The backend runtime declaration remains `>=18` because the application’s runtime support is a separate product decision. Any environment that installs or executes the lint toolchain must use the supported ESLint v10 Node line.

## Current migration surface

| Surface | Before | After | Risk |
|---|---|---|---|
| ESLint package | `eslint ^8.54.0`, lockfile resolved 8.57.1 | `eslint ^10.8.1` | High toolchain change; lockfile and rule behavior change |
| Config format | `packages/backend/.eslintrc.cjs` | `packages/backend/eslint.config.mjs` | High; legacy config lookup is no longer the default |
| Recommended preset | String-based `eslint:recommended` through eslintrc | `@eslint/js` `recommended` object | Medium; preset membership changed |
| Runtime globals | `env.node`, explicit test globals | `globals.node` plus explicit `describe`, `it`, `expect` | Medium; flat config requires direct language options |
| Ignore behavior | `ignorePatterns: ['node_modules/']` | Flat-config object with `ignores: ['node_modules/**']` | Medium; glob semantics differ |
| Companion packages | Transitive `@eslint/js`, `globals` | Explicit `@eslint/js ^10.0.1`, `globals ^17.11.0` | Low; makes the config contract reproducible |
| CI | Node 22, lint through workspace script | Node 22, same command with flat config | Low; workflow shape preserved |

## Breaking changes that matter to PayTray

### Flat configuration is mandatory for the supported path

ESLint v9 made flat config the default and stopped automatically searching for `.eslintrc` files. The new config imports JavaScript objects instead of resolving string-based `env`, `extends`, and `plugins` values. PayTray now uses `eslint.config.mjs`, direct `@eslint/js` recommended rules, `languageOptions`, and an explicit ignore object. This removes ambiguity about which lint rules cover recovery, payment, AI, and release-evidence scripts.

### Recommended-rule membership changes

The official migration guide documents changes to `eslint:recommended`, including new checks such as `no-constant-binary-expression`, `no-empty-static-block`, `no-new-native-nonconstructor`, and `no-unused-private-class-members`, along with other rule-default changes. The direct migration intentionally fixes the surfaced findings instead of disabling the preset. This matters because the affected files include payment-adjacent validation, release-evidence inspection, webhook/recovery tooling, and CI artifact verifiers.

### `no-unused-vars` and `no-useless-assignment` become more consequential

ESLint v9 changes `no-unused-vars` so caught errors are checked by default, and newer recommended rules identify assignments whose values are never subsequently used. PayTray’s migration found redundant initializers such as `let exitCode = 0`, `let parsed = null`, `let tokenAddress = null`, and `let vitestReport = null`, as well as genuinely unused imports and bindings. These were removed or rewritten without changing the observable success, blocked, or redacted output paths.

### Error causes must be preserved

The migration surfaced `preserve-caught-error` on subprocess and JSON/parsing wrappers. PayTray now chains the original error with `{ cause: error }` while retaining bounded, redacted user-facing messages. This improves diagnostic fidelity without exposing credentials, raw database content, or private operator evidence.

### Ignore files, CLI flags, and formatter assumptions change

Flat config does not automatically load `.eslintignore`; ignore patterns belong in the config itself. Several legacy CLI flags such as `--env`, `--ignore-path`, `--no-eslintrc`, `--rulesdir`, and `--resolve-plugins-relative-to` are not supported in flat-config mode. The PayTray workspace currently uses only `eslint .` and does not rely on removed formatters, custom rules, `RuleTester`, `eslint-env` comments, or `/* exported */` directives. That reduces migration risk.

### Node compatibility is a tooling gate

ESLint v9 dropped Node versions below 18.18 and ESLint 10.8.1 requires a newer supported Node line. PayTray’s CI and container use Node 22. The root/backend runtime engine declarations were not widened automatically because application runtime compatibility and development-tool compatibility are distinct contracts. A future runtime-engine change requires its own compatibility batch.

## Findings from the five-repetition confidence artifact

The pushed confidence artifact from GitHub Actions run [32336861746](https://github.com/OxCryptobot/PAYTRAY/actions/runs/32336861746) is bound to commit `5dded6a2b10b2263f4e0ce2c7231158c96951aa1`, has `status=verified`, `contentionTelemetry=true`, and contains 15 verified runs: five repetitions at each of c2, c4, and c8.

| Concurrency | Failed sequences | Integrity failures | Timeout wait runs | Throughput mean; CV | Sequence p95 mean; CV | Snapshot max mean; CV |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 0 | 0 | 0 | 2.210/s; 5.3% | 646.61 ms; 4.6% | 12.138 ms; 20.3% |
| 4 | 0 | 0 | 0 | 2.477/s; 4.0% | 1,315.26 ms; 4.2% | 53.088 ms; 75.0% |
| 8 | 0 | 0 | 2 | 1.745/s; 7.5% | 4,151.62 ms; 8.6% | 358.639 ms; 48.6% |

The two c8 `Timeout/SpinDelay` observations occurred in repetitions 1 and 4, one observation each, with one observed backend each. They are **sampled PostgreSQL wait labels**, not failed sequences, process errors, retries, or integrity failures. Every run remained `status=verified`, `failedSequences=0`, `integrityFailures=0`, and `databaseTelemetry.errors=[]`. The confidence artifact’s failure scan found no actual failure, blocked, exception, timeout-process, or unverified run marker; the only timeout strings were the wait-event labels described above.

The c8 tail is the primary performance signal. Its mean throughput is 1.745 sequences/s with a Student-t 95% interval of [1.583, 1.906], while mean sequence p95 is 4,151.62 ms with [3,708.046, 4,595.194]. Connection-acquisition maximum has a mean of 141.508 ms and a coefficient of variation of 31.3%; snapshot-query maximum has a mean of 358.639 ms and a coefficient of variation of 48.6%. Pool waiting remained zero at every level, so the data does not support a claim of pool-queue saturation. It does support continued investigation of c8 storage/telemetry overhead and tail behavior.

All WAL/pg_stat_io write and fsync timing counters, including phase-bound timing, were zero in this disposable environment. This remains diagnostic only and is not evidence that physical fsync cost is absent. The artifact also preserves null-target RTO semantics and the immutable safety fields:

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false,
  "rto": {
    "targetConfigured": false,
    "withinTarget": null
  }
}
```

## Isolated rollout plan

The migration is isolated to development tooling and lint-safe source hygiene. The required gate sequence is to install the locked v10 toolchain, verify the flat config with the legacy config removed, run focused lint and recovery-contract tests, run the complete `backend:quality:check`, execute `npm audit --audit-level=high`, validate the workflow YAML, check whitespace, and require a successful eight-job GitHub Actions run. Any lint change affecting payment-state transitions, verified chain evidence, settlement authority, shadow-only AI promotion, or human-review gates must be rejected unless its behavior is covered by existing characterization tests.

The next performance batch should remain separate from the ESLint migration. It should focus on c8 tail-latency attribution and telemetry overhead, not on converting these disposable measurements into production capacity or release SLOs.

## References

[1]: https://eslint.org/docs/latest/use/migrate-to-9.0.0 "ESLint: Migrate to v9.x"

[2]: https://eslint.org/docs/latest/use/configure/migration-guide "ESLint: Configuration Migration Guide"

[3]: https://eslint.org/blog/2024/04/eslint-v9.0.0-released/ "ESLint v9.0.0 released"

[4]: https://www.npmjs.com/package/eslint "ESLint package registry"
