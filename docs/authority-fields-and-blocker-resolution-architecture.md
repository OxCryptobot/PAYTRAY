# Fail-Closed Authority Fields and Blocker-Resolution Architecture

## Purpose

PayTray separates **evidence inspection**, **operational readiness**, **controlled release evaluation**, and **settlement authority**. The release system may automatically execute deterministic checks and track operator progress, but no evidence composer, CI job, tracker, or AI component may grant release authority or mutate payment state.

> A passing engineering check proves a bounded invariant. It does not prove human authorization, target readiness, reviewer identity, deployment readiness, or settlement authority.

## Authority-field contract

Every release-related report must preserve the following fields:

| Field | Required value during inspection, tracking, and CI | Meaning |
|---|---|---|
| `releaseEligible` | `false` | The report is not authorized to release the candidate. |
| `settlementAuthority` | `false` | The report cannot authorize payment, ledger, or stream mutation. |
| `mutation` | `read_only` or a explicitly bounded non-authority value | The report describes evidence only. |
| `applied` | `false` where present | No reviewer or ranking decision was applied by the verifier. |
| `deploymentPerformed` | `false` | No deployment was performed by the inspection path. |
| `settlementMutationPerformed` | `false` | No settlement or ledger mutation was performed. |

The implementation enforces these fields at multiple boundaries rather than trusting a single caller.

## Layered design

### 1. Evidence producers

Individual verifiers produce bounded redacted evidence. Examples include Railway preflight, verifier cursor, reconciliation, outbox health, key custody, cryptographic sequence, signed payload, and release-authority readiness. These producers reject sensitive keys, raw signatures, private material, user content, or authority-positive fields.

The authority-readiness composer in `packages/backend/scripts/verify-release-authority-readiness.mjs` requires exact commit binding and six predicates: approved release approval, complete release evidence, six terminal shadow reviews with zero pending, verified cryptographic sequence, independently verified signed payload, and safe non-authoritative evidence. It returns `ready_for_controlled_release_evaluation`, not `releaseEligible: true`.

### 2. Release-gate matrix

`packages/backend/scripts/verify-release-gates.mjs` executes deterministic repository checks and passes each result to `classifyOperationsCheck()` and `buildOperationsQualityReport()`. Missing target infrastructure or genuine operator evidence is classified as `operator_blocked` in normal mode; unexpected code failures remain failures. The matrix itself always emits false authority fields and read-only execution flags.

`packages/backend/lib/operationsQualityService.js` maintains the expected-blocker allowlist and machine-readable clearance criteria. The new `release-authority-readiness` check is an expected operator blocker, not an unexpected engineering failure.

### 3. Resolution tracking

`packages/backend/scripts/verify-release-blocker-resolution.mjs` consumes a redacted `release_gates` report and optionally a separately supplied redacted tracking manifest. It does not rerun or bypass gates, submit evidence, mutate a database, or clear a blocker. It maps each check to:

| Output state | Source of truth | Interpretation |
|---|---|---|
| `verified_by_release_gate` | Current check state is `passed` | The automated gate passed in this run. |
| `unassigned` | No tracking entry supplied | No operator progress was recorded. |
| `operator_in_progress` | Operator tracking metadata | Work is claimed, not verified. |
| `evidence_submitted` | Operator tracking metadata | An artifact reference was recorded, not accepted as gate evidence. |
| `rejected` | Operator tracking metadata | The submitted progress item was rejected or requires correction. |

Tracking metadata can never convert `operator_blocked` into `verified_by_release_gate`. Only a fresh release-gate execution can produce that state. `releaseCommit` is required and all tracking entries must match actual release-gate check names.

A tracking entry may include an independently verified redacted evidence reference with this shape:

```json
{
  "kind": "verifier_cursor",
  "target": "authenticated_target",
  "path": "/protected/paytray/verifier-cursor-<COMMIT>.json",
  "sha256": "<64 lowercase hex characters>",
  "reportKind": "verifier_cursor_evidence",
  "releaseCommit": "<40 lowercase hex characters>",
  "verificationStatus": "independently_verified"
}
```

The tracker resolves the path through the shared absolute-path validator, enforces the authenticated protected evidence root and symlink boundary, reads only JSON, computes SHA-256 over the exact file bytes, compares the declared digest and report kind, binds any embedded `releaseCommit`, recursively rejects sensitive keys, and preserves the reference as `referenceState: "independently_verified_reference"`. This state records a verified reference; it does not clear the release-gate state. References may point to redacted reports only and must not contain private keys, raw signatures, secret values, reviewer notes, or user content.

The tracker also publishes a versioned dependency graph and a `nextAttemptableBlockers` list. A blocker is actionable only when its prerequisite gates are currently `passed`; dependent blockers expose `blockedBy` and a deterministic `nextAction`. This is scheduling guidance for operators, not an automatic clearance mechanism. For example, verifier operations wait on target migrations and Railway evidence, while release-authority readiness waits on the complete evidence, approval, payload, custody, cursor, and reconciliation chain.

### 4. Controlled authority path

The only permitted authority transition is the separately controlled release-approval path after target evidence, human shadow-review decisions, four role sign-offs, four EIP-191 attestations, Ed25519 custody, manifest, and signed-payload predicates are genuinely verified. The readiness composer only proves that this final controlled evaluation may be attempted.

## CI automation boundary

The release-gates CI job now runs the resolution tracker after producing `artifacts/release-gates.json`, then validates the emitted report with `verify-ci-matrix-artifact.mjs` using `reportKind: release_blocker_resolution`. It records `artifacts/release-blocker-resolution.json`, fingerprints it with the other redacted release artifacts, and uploads it for operator follow-up. CI uses the exact GitHub commit SHA and `local_disposable` classification. The job never submits human decisions, reads production secrets, deploys, sends transactions, or changes payment state. A malformed tracker report therefore fails the artifact contract instead of being accepted as a valid progress report.

## Required operator workflow

1. Run the release-gate matrix against the intended target and capture the exact commit SHA.
2. Review the blocker-resolution artifact to distinguish automated passes from open operator blockers.
3. Resolve blockers only through the authorized operational process described by each `clearanceCriteria` value.
4. Store only redacted artifact references and SHA-256 fingerprints in the tracking manifest.
5. Re-run the actual release-gate matrix after each material change; do not mark a blocker cleared solely from tracking metadata.
6. Continue to preserve `releaseEligible: false`, `settlementAuthority: false`, `mutation: read_only`, and false execution flags until the controlled authority path is explicitly reached.

## Safety tests

The tracker tests cover open-blocker tracking, automated gate resolution, operator-progress states, exact commit binding, orphan tracking entries, sensitive-field rejection, nested authority violations, unsafe mutations, duplicate gate checks, unexpected engineering failures, and the complete non-authoritative state. The tracker is intentionally a **resolution recorder and verifier**, not an authority-granting mechanism.

## Bounded advisory-AI and downstream evidence

The `advisory-ai` blocker is handled through `backend:advisory:ai:check` and `backend:release:advisory-ai:evidence:check`. Capability evidence must prove an explicitly enabled and configured provider/model, bounded latency and cost, bounded retrieval, valid retention, raw-content persistence disabled, human review required, promotion remaining `shadow_only`, and read-only non-authority fields. The verifier accepts only redacted, exact-commit-bound `advisory_ai_evidence` reports and returns `verified_reference` without clearing the fresh release gate.

The blocker-resolution dependency graph now includes `advisory-ai` as a prerequisite of `release-evidence`. A verified reference does not satisfy the dependency; only a subsequent fresh release-gate run can change the `advisory-ai` gate to `passed`. Downstream target operations, token metadata, verifier cursor, reconciliation, release evidence, approval, payload, and authority stages remain independently gated. No advisory output may be applied to payment state or promote AI ranking.

## Downstream operational evidence

The next downstream stage is composed by `backend:release:downstream:operations:evidence:check`. It consumes separate redacted `target_operations_evidence` and `token_metadata_evidence` reports, binds each to the exact release commit, validates protected paths and SHA-256 source hashes, requires all target-operations preflight checks to be ready, requires Base Sepolia chain ID `84532` with every enabled token metadata record matched, and preserves `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, `applied=false`, and no deployment or settlement mutation. A verified component reference remains evidence only; a fresh release-gate run must verify the downstream checks before dependent release evidence can proceed.

## Verifier, recovery, and durable-operations evidence

The `backend:release:verifier:durable:operations:evidence:check` command composes three redacted references: `recovery_evidence`, `verifier_reconciliation_evidence`, and `durable_worker_evidence`. It requires an isolated recovery with 19 migrations, fresh verifier status, verified zero-issue reconciliation, outbox health `ok`, outbox worker `ready`, and idempotency cleanup `ready`. Each source is bound to the exact release commit and protected path, recursively redacted, SHA-256 fingerprinted, and checked for false/read-only authority fields. The result is evidence-only and cannot clear a fresh gate, mutate payment state, or grant release authority.

## Blocker-resolution artifact fingerprint

The release-gates CI job now creates `release-blocker-resolution.json.sha256` immediately after generic artifact validation and runs `backend:release:blocker:resolution:fingerprint:check`. The verifier binds the artifact report kind, exact commit, sidecar digest, count fields, and false/read-only authority fields. It returns `verified_reference` only for artifact integrity; it cannot resolve a blocker, change release-gate state, or grant authority. Both the sidecar and redacted fingerprint report are retained with the release-gate artifact bundle.

## Human worksheet artifact binding

The human-controlled shadow-review runner now requires each worksheet to carry the exact lowercase 40-character `releaseCommit` and lowercase 64-character `artifactSha256`. Dry-run output echoes the hash as redacted provenance with `networkRequestsPerformed=false`. Submit mode requires `PAYTRAY_REVIEW_EXPECTED_COMMIT` and `PAYTRAY_REVIEW_EXPECTED_ARTIFACT_SHA256` to match the worksheet exactly; mismatches fail before any network request. This binds human review intent to the same release artifact used by reviewer attestations while preserving `submissionPerformed=false`, `applied=false`, `promotionStatus=shadow_only`, `releaseEligible=false`, and `settlementAuthority=false` on validation paths.

## Smoke-phase2 evidence

The controlled Phase 2 harness emits `smoke_phase2_evidence` with an exact release commit, isolated-database proof, Base Sepolia chain ID `84532`, disabled mainnet policy, an enabled token address, a complete discovery-to-outcome flow, replay protection, and explicit `chainTransactionSubmitted=false` / `settlementMutationPerformed=false`. `backend:release:smoke:phase2:evidence:check` validates the redacted report and returns evidence only; it does not submit a transaction, mutate settlement state, or clear the `smoke-phase2` blocker.

## Release-evidence reference

`backend:release:evidence:reference:check` validates a redacted `release_evidence` envelope against the exact commit, all twelve required evidence checks, reconciled `evidenceComplete`, the SHA-256 evidence fingerprint shape, four-role and four-attestation summaries, and the immutable `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`, and execution-false fields. A `verified_reference` result remains aggregation evidence and cannot replace authenticated target evidence, human sign-offs, shadow-review decisions, operator-key custody, release approval, manifest, or signed payload verification.

## Liveness and readiness probe separation

The backend now exposes `/livez` and `/api/health/liveness` as process-only liveness endpoints. They return HTTP 200 with `status=alive`, `live=true`, `dependencyChecksPerformed=false`, `Cache-Control: no-store`, and immutable read-only safety fields; they do not query PostgreSQL, RPC, token registry, verifier workers, or external providers. Strict dependency readiness remains on `/readyz` and `/api/health/readiness`, which may return HTTP 503 when the configured environment is not ready. This prevents an intentionally unready deployment from being restarted merely because it is not yet safe to receive application traffic. The liveness contract is diagnostic evidence only and cannot establish release eligibility, settlement authority, or deployment completion.

## Performance telemetry observability contract

Telemetry health now exposes bounded, non-authoritative performance context: total sample count, configured minimum sample count, sample sufficiency, aggregate p95 ingestion lag, and the configured p95 target. `withinTarget` is `null` until the minimum sample count exists; it is never inferred from an empty or insufficient dataset. The output also carries `releaseEligible: false`, `settlementAuthority: false`, `mutation: 'read_only'`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`. These metrics are for diagnostics and release-readiness context only; they do not grant deployment, payment, settlement, AI-promotion, or release authority.

## PostgreSQL recovery timing and RTO evidence

Disposable recovery evidence now supports phase-bound timing for backup, backup-integrity hashing, restore, catalog inspection, and restored-database verification. The optional `RECOVERY_RTO_TARGET_MS` value is operator-supplied planning context; when absent, `timing.rto.withinTarget` remains `null` and a CI job wall-clock duration must not be called an RTO pass. The recovery artifact verifier checks timestamp shape, nonnegative durations, phase status, target consistency, and false/read-only authority fields. Recovery integrity still requires distinct local disposable databases, 19 ordered migrations, ready-PostgreSQL contracts, redacted artifact SHA-256 sidecars, and no deployment or settlement mutation.
