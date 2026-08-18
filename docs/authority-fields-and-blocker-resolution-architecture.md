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
