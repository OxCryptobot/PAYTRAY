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

### 4. Controlled authority path

The only permitted authority transition is the separately controlled release-approval path after target evidence, human shadow-review decisions, four role sign-offs, four EIP-191 attestations, Ed25519 custody, manifest, and signed-payload predicates are genuinely verified. The readiness composer only proves that this final controlled evaluation may be attempted.

## CI automation boundary

The release-gates CI job now runs the resolution tracker after producing `artifacts/release-gates.json`. It records `artifacts/release-blocker-resolution.json`, fingerprints it with the other redacted release artifacts, and uploads it for operator follow-up. CI uses the exact GitHub commit SHA and `local_disposable` classification. The job never submits human decisions, reads production secrets, deploys, sends transactions, or changes payment state.

## Required operator workflow

1. Run the release-gate matrix against the intended target and capture the exact commit SHA.
2. Review the blocker-resolution artifact to distinguish automated passes from open operator blockers.
3. Resolve blockers only through the authorized operational process described by each `clearanceCriteria` value.
4. Store only redacted artifact references and SHA-256 fingerprints in the tracking manifest.
5. Re-run the actual release-gate matrix after each material change; do not mark a blocker cleared solely from tracking metadata.
6. Continue to preserve `releaseEligible: false`, `settlementAuthority: false`, `mutation: read_only`, and false execution flags until the controlled authority path is explicitly reached.

## Safety tests

The tracker tests cover open-blocker tracking, automated gate resolution, operator-progress states, exact commit binding, orphan tracking entries, sensitive-field rejection, nested authority violations, unsafe mutations, duplicate gate checks, unexpected engineering failures, and the complete non-authoritative state. The tracker is intentionally a **resolution recorder and verifier**, not an authority-granting mechanism.
