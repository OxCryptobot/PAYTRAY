# PayTray Remaining Build and Release Checklist

**Project:** PayTray — AI-enabled time-to-money platform connecting expert discovery, real-time collaboration, and ERC-20 payment streams.

**Branch:** `paytray/batch-delivery`

**Current pushed branch:** `origin/paytray/batch-delivery` (verify the exact tip with `git rev-parse HEAD` and `git rev-parse origin/paytray/batch-delivery`).

**Safety boundary:** Base Sepolia (`84532`) remains the safe settlement default. The verifier and ledger remain the economic authority. AI remains `shadow_only`. No live funds, mainnet transaction, production deployment, real user-data migration, fabricated approval, or fabricated signing key is authorized by this checklist.

## 1. Current delivery state

The latest multi-phase tranche is validated and pushed to the remote branch. It adds guarded shadow-review submission, exact release-commit binding, a read-only post-attestation release-gate sequence verifier, and reusable skill guidance on top of the recovery and Migration 015 hardening. The latest pushed branch tip before this batch is `a05ec452a23464c4b995cc7f5f54b3044d03cd15`; the current local hardening batch adds a read-only verifier/reconciliation evidence composer and CI retention for both source reports plus their SHA-256 fingerprints.

| Batch | Capability | State | Evidence |
|---|---|---|---|
| AP | Ed25519 canonical release payload construction | Pushed | `19a78e0a5bf53ea9e63f70af74b470a8e330d06e` |
| AQ | Detached signed-payload verification and tamper rejection | Pushed | `c447a5218bb221deac08df4b490ac56dbe27ff8e` |
| AR | Read-only paginated/filterable financial audit events with metadata redaction | Pushed | `packages/backend/lib/auditLogService.js`; `GET /api/v2/ops/audit/events` |
| AS | Production chain/protocol/token-registry consistency validation | Pushed | `packages/backend/lib/payments/tokenRegistry.js`; deployment preflight |
| AT | Discovery impression → engagement → outcome lineage | Pushed | `packages/backend/lib/discoveryLineageService.js`; `GET /api/v2/ops/discovery/lineage` |
| AU | Isolated PostgreSQL recovery evidence with backup fingerprint and restore verification | Pushed | `packages/backend/scripts/verify-recovery-evidence.mjs`; disposable restore returned `verified` |
| AV | Verifier operations evidence CLI and scoped operator endpoint | Pushed | `packages/backend/lib/verifierOperationsEvidence.js`; `GET /api/v2/ops/verifier/operations` |
| AW | Route-level contracts plus ready-PostgreSQL integration fixture | Pushed | `packages/backend/scripts/verify-ready-postgres-contracts.mjs`; isolated CI target returned `status: verified` |
| AX | Read-only ERC-20 symbol/decimals/chain metadata probe | Pushed | `packages/backend/lib/payments/tokenMetadataProbe.js` |
| AZ | Lineage-backed evaluation export coverage | Pushed | `packages/backend/lib/evaluationExport.js` |
| BC | Controlled Base Sepolia smoke harness with disposable-data and no-chain-mutation guards | Pushed | `packages/backend/scripts/verify-phase2-loop.mjs` |
| BD | Versioned v2 operations, lineage, and public extension schemas | Pushed | `packages/backend/lib/extensionContracts.js`; `/api/v2/extensions/contracts`; updated API documentation |
| AY | Durable outbox and operator delivery health | Pushed | `packages/backend/lib/outboxDeliveryService.js`; `GET /api/v2/ops/outbox/health` |
| BA | Bounded advisory-AI provider and retrieval boundary | Pushed | `packages/backend/lib/advisoryAiBoundary.js`; `POST /api/v2/intelligence/advisory` |
| BB | Collaboration degraded-state health | Pushed | `packages/backend/lib/collaborationHealth.js`; `GET /api/v2/collaboration/health` |
| BF | Durable reviewer-decision audit records | Pushed | `810868f97ab0b8706dfde5747830d9e935eb7c67`; `shadow_review_recorded` and `shadow_review_replayed` financial audit events |
| BG | Verifier-owned engagement payment-state surface | Pushed | `a40adb4f4a83e15d9806ebefc7047641085784d6`; `GET /api/v2/engagements/:engagementId/payment-state` |
| BH | Durable outbox delivery processor | Pushed | `a40adb4f4a83e15d9806ebefc7047641085784d6`; `POST /api/v2/ops/outbox/process` |
| BI | Ready-PostgreSQL BG/BH verification and webhook signature security | Pushed | `124701ba78d79d96f2abd51ccd59580e9db86a49`; extended `verify-ready-postgres-contracts.mjs`, shared exact-body HMAC signer/verifier, timestamp tolerance, stable event identifiers, and bounded replay guard |
| BJ | End-to-end simulated webhook replay-load validation and shared durable-store guidance | Pushed | `210f2573025ef1fe7bbff2965fc63172ac3b68f6`; 100 captured deliveries, exact HMAC verification for every event, duplicate replay rejection, and PostgreSQL/Redis atomic-claim integration guidance |
| BK | Shadow-review approval and isolated-recovery operator runbook | Implemented locally | `docs/shadow-review-and-recovery-operator-runbook.md`; non-submitting `approved_pilot` templates, post-submit verification, isolated restore commands, and exact 17-migration evidence requirements |
| BL | Durable idempotency expiry cleanup and shared webhook replay claims | Pushed | `cbbec7311f8e98547226af6a50567e338ac91601`; `backend:idempotency:cleanup`, migration `014_webhook_replay_claims`, atomic PostgreSQL replay claim adapter, signature-before-claim verifier boundary, and bounded cleanup tests |
| BM | Durable verifier-owned trust-signal persistence and derivation | Pushed | `cffc9c2`; migration `015_verified_trust_signals`, verified-outcome-only derivation, idempotent participant-specific signals, neutral dispute evidence, operator listing, and permanent `eligibleForRanking=false`. |
| BN | Durable webhook inbox state machine | Pushed | `cffc9c2`; migration `016_webhook_inbox`, atomic first claim, lease reclaim, processed/retryable/quarantined states, bounded retry, raw-content rejection, and health evidence. |
| BO | Durable extension hooks and production outbox worker | Pushed | `cffc9c2`; migration `017_extension_hooks`, durable v2 hook registration/listing, explicit `OUTBOX_WORKER_ENABLED=true` entrypoint, bounded polling/leases/batches, signing-secret requirement, and graceful shutdown. |
| BP | Versioned public extension OpenAPI and dependency-free SDK | Pushed | `d63c046`; public `/api/v2/extensions/openapi.json`, runtime-to-OpenAPI contract verifier, `@paytray/sdk` Node 18+ client with TypeScript declarations, HTTPS registration helper, structured API errors, and read-only safety metadata. |
| BQ | Explicit production idempotency-cleanup schedule contract | Pushed | `7f7a264`; opt-in `backend:idempotency:cleanup:run`, read-only `backend:idempotency:cleanup:check`, bounded 15-minute/500-record defaults, production-time override rejection, and external-host scheduler guidance. |
| BR | Unified target-operations configuration preflight | Pushed | `de44809`; read-only `backend:target:operations:check` composes redacted Railway settings, Base Sepolia policy, HTTPS RPC, worker/housekeeping opt-ins, and named blockers; it always emits `releaseEligible: false`. |
| BS | Production Base Sepolia verifier-worker entrypoint | Pushed | `6e857f2`; explicit `VERIFIER_WORKER_ENABLED=true` gate, HTTPS RPC/protocol/token consistency, transactional bounded polling, durable cursor projection, and graceful shutdown. |
| BT | Reproducible CI and shared quality gate | Pushed | `6e857f2`; `.github/workflows/paytray-quality.yml`, `backend:quality:check`, locked npm install, Node 22, full tests/lint/extension contract, migrations, and isolated PostgreSQL route checks. |
| BU | HTTP and rate-limit hardening | Pushed | `6e857f2`; explicit proxy trust, bounded JSON/urlencoded request body size, expired-key eviction, and configurable rate-limit key budget. |
| BW | SDK/OpenAPI runtime and type contract drift verification | Pushed | `a8c90bb`; read-only `backend:sdk:contract:check` captures SDK request paths, OpenAPI operation IDs, runtime safety metadata, registration defaults, and TypeScript declaration parity without network access. |
| BX | Read-only release-evidence aggregation | Pushed | `a8c90bb`; `backend:release:evidence:check` composes target, verifier, reconciliation, delivery, shadow-review, rollback, sign-off, and signing-key evidence while always emitting `releaseEligible: false`. |
| BZ | Composite operator runtime health and SLO report | Pushed | `35550cc`; `GET /api/v2/ops/runtime/health` reports bounded API availability/latency observations, database, collaboration, verifier, outbox, webhook inbox, and telemetry status with immutable read-only metadata. |
| CA | Ready-PostgreSQL runtime-health contract | Pushed | `35550cc`; isolated verifier checks runtime-health status `200/503`, `mutation: read_only`, `settlementAuthority: false`, and `releaseEligible: false`; overall verifier returned `status: verified`. |
| CB | Canonical hashed reconciliation evidence | Pushed | `918d115`; `backend:reconciliation:evidence:check` wraps the durable reconciliation report with deterministic SHA-256 evidence hashing, commit boundary, issue count, and immutable read-only authority metadata. |
| CC | Centralized release/reconciliation evidence collectors | Pushed | `661af74`; shared collectors make the CLI and API use one database-backed evidence contract, with sign-off file parsing, target preflight, verifier, readiness, delivery, and reconciliation assembly. |
| CD | Authenticated operator evidence APIs | Pushed | `661af74`; `GET /api/v2/ops/release-evidence` and `GET /api/v2/ops/reconciliation/evidence` expose read-only evidence with structured `503` behavior and no settlement, approval, or AI-promotion authority; ready-PostgreSQL route checks pass. |
| CE | Immutable evidence fingerprint utility | Pushed | `42fb774`; canonical SHA-256 fingerprints for release, reconciliation, and unified operator evidence; no secrets or signing-key material included. |
| CF | Unified operator evidence surface | Pushed | `42fb774`; `GET /api/v2/ops/evidence` combines release and reconciliation evidence, returns structured `503` until complete, and remains `releaseEligible: false` and `settlementAuthority: false`. |
| CG | Operations-quality matrix | Pushed | `d4e65f0`; `backend:operations:quality:check` runs the nine existing read-only checks; normal mode exits `0` with `status: operator_blocked` and six expected operator blockers without a database, while strict mode exits `1` until all target evidence is real. |
| CH | CI operations-quality enforcement | Pushed | `5635f81`; separate GitHub Actions `operations-quality` job uses Node 22, locked dependencies, and `OPERATIONS_QUALITY_STRICT=false`; expected operator blockers do not fail CI, but unexpected check failures do. |
| CI | Read-only operator health dashboard | Pushed | `df31945`; authenticated `GET /api/v2/ops/health/dashboard` aggregates runtime, outbox, webhook inbox, verifier, and unified evidence components; isolated ready-PostgreSQL route verification returned `status: verified` and preserved `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`. |
| CK | Durable operations-quality audit trail | Pushed | `d105cf1`; migration `018_operations_quality_runs`, redacted canonical report hashing, best-effort CLI persistence, bounded `GET /api/v2/ops/operations-quality/runs`, and ready-PostgreSQL coverage; application metadata remains non-financial and read-only. |
| CL | Detailed operations-quality audit lookup | Pushed | `6c4c64e`; UUID-validated `GET /api/v2/ops/operations-quality/runs/:runId` returns one persisted redacted report and canonical hash, rejects malformed identifiers before lookup, returns `404` for missing runs, and preserves immutable safety metadata. |
| CM | Canonical operator evidence-bundle export | Pushed | `3d6c524`; `GET /api/v2/ops/evidence/bundle` and `backend:ops:evidence:bundle:check` compose release, reconciliation, and operations-quality history into a deterministic SHA-256 bundle; incomplete evidence remains fail-closed at `503`/exit `1`. |
| CN | Evidence-bundle operations-quality integration | Pushed | `98db605`; the nine-check `backend:operations:quality:check` matrix now includes the bundle CLI; normal mode classifies the missing real release evidence as `operator_blocked` with zero unexpected failures, while strict mode remains fail-closed. |
| CO | Detached evidence-bundle integrity verification | Pushed | `52255ae`; `backend:ops:evidence:bundle:verify` recomputes the canonical SHA-256 fingerprint, normalizes PostgreSQL timestamps, rejects tampering and safety-field changes, and verifies blocked artifacts without granting release or settlement authority. |
| CR | Automated release-gate matrix | Validated locally | Added `backend:release:gates:check` and a standalone CI job that executes 19 read-only gate checks, retains redacted JSON plus SHA-256 evidence, and classifies missing target/human evidence as `operator_blocked` with zero unexpected failures. |
| CS | CI unit-job database isolation | Validated locally | The unit quality job now runs with `DATABASE_URL: ''`, matching the no-database test contract and preventing CI’s global PostgreSQL variable from changing collaboration-health failure semantics. |
| CT | Automated backup and isolated recovery validation | Validated locally | Added a PostgreSQL 16 CI job that creates a disposable custom-format backup, restores into a separate database, requires migration 018, verifies ready-PostgreSQL contracts, and uploads only redacted summaries plus SHA-256 evidence; target recovery remains a release gate. |
| CU | CI recovery source-schema initialization | Pushed | `38e0a8b`; the recovery job initializes the migration-018 source schema before backup, preventing empty-service-database failures while keeping restore evidence isolated and non-deploying. |
| CV | Release-gate operations-quality integration | Pushed | `5ae2a26`; `backend:operations:quality:check` includes `backend:release:gates:check` as an expected operator-blocked check; normal mode reports 10 checks, 7 expected blockers, and 0 unexpected failures. |
| CX | Latest durable release-gate operator endpoint | Pushed | `5ae2a26`; authenticated read-only `GET /api/v2/ops/release-gates/latest` selects only `reportKind: release_gates` audit rows and returns structured `503` when no durable release-gate run exists. |
| CY | Release-gate and evidence workflow documentation | Pushed | `5ae2a26`; updated the v2 operations and lineage contract plus batch documentation with durable release-gate provenance and non-releaseable operator evidence semantics. |
| CW | Railway non-secret project/service metadata observability | Pushed | `1461adb`; the Railway trial report accepts only operator-supplied project, environment, and allowlisted web/worker service-status metadata; incomplete metadata remains `metadata_unavailable`, settings are never inferred, and safety fields remain read-only/non-releaseable. |
| CZ | CI matrix-artifact contract validation | Pushed | `e9150bc`; added `backend:ci:matrix:check` and CI steps that verify report provenance, count reconciliation, recursive sensitive-key absence, immutable safety flags, and read-only authority before SHA-256 fingerprinting/upload. Operations quality verified 10 checks; release gates verified 19 checks; both had 0 unexpected failures. |
| DA | Human reviewer-role and Ed25519 evidence contract | Validated locally | Release evidence now requires the four distinct roles `release_operator`, `protocol_finance`, `ai_data`, and `security`, plus operator-key presence, a 64-hex public-key fingerprint, and independent fingerprint verification. No private key or reviewer identity is emitted; release authority remains false. |
| DB | Read-only human-evidence worksheet validator | Validated locally | Added `backend:human:evidence:check` to validate exactly four distinct sign-off roles and the six known shadow-run entries, reject placeholders and sensitive fields, and emit only `prepared`/`blocked` read-only metadata. It never submits reviews or grants release authority. |
| DC | Commit-pinned draft evidence preparation | Validated locally | Added `mode: draft` support so the current six-run inspection and four-role record skeleton validate as `draft_prepared` while `prepared: false`, `submissionPermitted: false`, `submissionPerformed: false`, `releaseEligible: false`, and `settlementAuthority: false` remain immutable. |
| DD | Read-only shadow-review status snapshot | Validated locally | Added `backend:shadow:reviews:check` and a safe snapshot builder that reports all six expected runs, pending/terminal counts, reviewer assignment presence, and reviewed timestamps without exposing notes or mutating decisions. Current status is `pending_human_review` with 6 pending and 0 terminal decisions. |
| DE | Automated reviewer identity and cryptographic attestation binding | Validated locally | Added migration 019, server-issued role/commit/artifact/fingerprint challenges, JWT-wallet-bound EIP-191 verification, one-time challenge consumption, message-hash tamper detection, redacted attestation inspection, and a release-evidence check requiring four verified attestations for the exact release commit. No signature bytes, notes, approvals, or authority are exposed or granted. |
| DF | End-to-end Ed25519 operator-key custody and fingerprint verification | Validated locally | Added `backend:release:key:custody:check`, in-memory Ed25519 private/public-key derivation matching, exact public-key PEM SHA-256 comparison, approved-secret-manager source/version/protection checks, an EIP-191-signed security fingerprint attestation bound to the exact commit and key version, a non-secret custody manifest requiring ephemeral access and no key export, secret-free output, and `operator-key-custody` expected-blocked integration in the 20-check release-gate matrix. |
| DG | Explicit ephemeral secret-manager custody validation | Pushed | `6d8482e`; added `backend:release:key:secret-manager:check`, strict non-secret custody-manifest validation, ephemeral injection and non-persistence checks, secret-field rejection, exact secret-name/version/commit/fingerprint binding, and `secret-manager-custody` expected-blocked integration in the 21-check release-gate matrix. Remote CI passed all six jobs. |
| DI | Standalone secret-manager custody operations-quality check | Pushed | `8b193a3`; added `secret-manager-custody` to the operations-quality matrix. Normal mode reports 11 checks, 8 operator blockers, and 0 unexpected failures; strict mode remains fatal and authority stays read-only. |
| DJ | Operator custody and recovery runbook refresh | Pushed | `8b193a3`; added separate operator-key and ephemeral secret-manager custody commands, strict-mode interpretation, no-secret-output rules, and current 19-migration recovery evidence to the shadow-review/recovery runbook. |
| DK | CI required-check artifact contract | Pushed | `8b193a3`; the redacted matrix verifier accepts required check names and the release-gate artifact step requires `secret-manager-custody`; remote CI passed all six jobs. |
| abfb232 | Production and contract hardening batch | Pushed | `abfb232b99f81a44243a193a2a5b16b612691b21`; migration 018/016/019 contracts, reviewer-attestation race, operations-quality artifact verification, production Docker build/healthcheck, keyboard-accessible UX polish, deferred client rendering, and port-isolated smoke E2E; all six CI jobs passed. |
| Current follow-up | Recovery artifact bundle verifier and Migration 015 trust-signal contract | In progress locally | Adds allowlisted recovery JSON/schema/sidecar verification, 19-migration enforcement, three foreign-key checks, polarity/score/ranking-eligibility/uniqueness checks, and restored-database wiring; release and settlement authority remain false. |
| CP | CI operations-quality artifact retention | Pushed | `7c91fbc`; the standalone CI matrix emits a redacted `artifacts/operations-quality.json` file and uploads it for seven-day operator inspection; expected blockers remain non-failing and unexpected failures remain fatal. |
| CQ | CI operations-quality artifact fingerprint | Validated locally | The CI job writes `artifacts/operations-quality.json.sha256` beside the redacted matrix report before upload, enabling independent integrity checks without altering authority semantics. |
| Post-attestation sequence | Read-only ordered release-gate sequencing | Implemented locally | `backend:release:post-attestation:sequence:check` maps target evidence, recovery, verifier freshness, reconciliation, durable workers, human evidence, custody, manifest, and payload stages; it remains `operator_blocked` until real evidence passes and never grants authority. |
| Attestation bundle | Four-role redacted EIP-191 attestation evidence contract | Implemented locally | Added `backend:release:reviewer-attestations:bundle:check`; requires exactly one verified `approved` attestation for each role, shared commit/artifact/fingerprint binding, distinct wallets, no raw signatures, and immutable false/read-only safety fields. |
| Durable-worker evidence | Redacted outbox, worker, and idempotency evidence composer | Implemented locally | Added `backend:release:durable-worker:evidence:check`; composes pure JSON reports with SHA-256 source hashes, preserves local-versus-authenticated-target classification, and retains all authority fields false/read-only. |
| Verifier/reconciliation evidence | Fresh-cursor and zero-issue evidence composer | Implemented locally | Added `backend:release:verifier-reconciliation:evidence:check`; requires verifier status `fresh` and reconciliation status `ok`/`verified` with zero issues, records source SHA-256 hashes, rejects sensitive keys, classifies evidence target, and remains `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`. CI captures and uploads the redacted source/composed reports. |
| Verifier cursor evidence | Strict durable cursor evidence contract | Implemented locally | Added `backend:release:verifier:cursor:evidence:check`; requires a ready verifier report, Base Sepolia chain ID `84532`, `verifierStatus.status=fresh`, a nonnegative `last_scanned_block`, parseable `updated_at`, and `unlinkedEvidenceCount=0`. It is now a first-class release-gate matrix check and a required member of the `fresh-verifier` post-attestation stage; it fingerprints the source report, blocks missing/stale/malformed cursors, and preserves read-only/non-authoritative flags. Operations-quality reports now also emit a machine-readable `clearanceCriteria` string for every expected blocker. Added `backend:release:blocker:clearance:check`, which fingerprints the canonical release-gates report and emits an ordered, redacted blocker plan; CI retains this plan with the release-gate evidence bundle. The plan remains `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`. |
| Human evidence and Ed25519 custody | Redacted four-role sign-off, reviewer-attestation, and key-custody status composer | Implemented locally | Added `backend:release:human:evidence:custody:check`; consumes redacted release-evidence, operator-key-custody, and secret-manager-custody reports, computes source SHA-256 hashes, requires all four roles (`release_operator`, `protocol_finance`, `ai_data`, `security`) for both sign-offs and commit-bound attestations, rejects sensitive key material, and requires verified ephemeral Ed25519 custody. It reports status only and never grants release authority. For `authenticated_target`, every input path must be absolute, inside `PAYTRAY_PROTECTED_EVIDENCE_ROOT` (default `/protected/paytray`), and free of symlink escapes. |
| Cryptographic release sequence | Ordered evidence binding for attestations, custody, manifest, and signed payload | Implemented locally | Added `backend:release:cryptographic:sequence:check`; binds redacted release evidence, a verified four-role attestation bundle, operator/secret-manager custody, release manifest, and signed payload to one exact commit, artifact hash, and public-key fingerprint. Every step must verify, but the composer remains evidence-only with `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`. CI now retains its expected-blocked local-disposable report with the read-only release-gate artifact bundle. Synthetic fixture commands remain disposable schema tests and cannot be submitted or treated as human/target evidence. |
| Release-authority readiness | Final evidence-only conjunction before controlled release evaluation | Implemented locally and integrated | Added `backend:release:authority:readiness:check`; requires exact commit binding, approved/eligible release-approval artifact, complete release evidence, all six terminal shadow reviews, verified cryptographic sequence, and independently verified signed payload. It now appears as a first-class `release_gates` check and the final post-attestation stage. Its seven-test suite covers complete readiness, pending/missing evidence, commit mismatch, sensitive/authority violations, CLI fail-closed behavior, disposable redacted source hashing, and authenticated protected-root enforcement. It returns `ready_for_controlled_release_evaluation` only when every predicate passes, but always preserves `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`; only the controlled release path may evaluate authority. |
| Blocker-resolution tracking | Automated, read-only resolution progress over release-gate output | Implemented locally and wired into CI | Added `backend:release:blocker:resolution:check` and `verify-release-blocker-resolution.mjs`. It maps passed checks to `verified_by_release_gate`, tracks operator progress as `unassigned`, `operator_in_progress`, `evidence_submitted`, or `rejected`, requires exact commit binding, rejects sensitive/nested authority violations and duplicate checks, and never treats tracking metadata as gate clearance. It now ingests independently verified redacted evidence references by validating absolute/protected paths, symlink boundaries, report kind, exact file SHA-256, and commit binding; accepted references are marked `independently_verified_reference` without clearing the associated gate. It also emits a versioned dependency graph, `blockedBy`, deterministic `nextAction`, and `nextAttemptableBlockers` guidance without changing gate state. CI now validates the tracker with the generic CI artifact contract before retention. CI retains `release-blocker-resolution.json` with the redacted release-gate artifact bundle. Architecture details are documented in `docs/authority-fields-and-blocker-resolution-architecture.md`. |
| Foundation blocker evidence | Read-only migration and Railway-trial evidence references | Implemented locally | Added `backend:release:foundation:blockers:check` and `verify-foundation-blocker-evidence.mjs`. It validates redacted `migration_evidence` and `railway_trial_evidence` reports by exact commit, source SHA-256, report kind, protected path, redaction, complete migrations 001–019, ready PostgreSQL status, authenticated Railway metadata, HTTPS origin, Base Sepolia chain ID `84532`, and mainnet disabled. It reports `verified_reference` only and never clears the release-gate matrix or grants authority. |
| Advisory-AI evidence and downstream gates | Bounded provider/retrieval/cost/latency evidence with shadow-only downstream sequencing | Implemented locally | Added `backend:release:advisory-ai:evidence:check` and `verify-advisory-ai-evidence.mjs`. It validates redacted advisory capability reports, exact commit binding, protected paths, provider/model configuration, bounded budgets, raw-content prohibition, human review, `promotionStatus=shadow_only`, `applied=false`, and `mutation=read_only`. The tracker now accepts `advisory_ai` references and makes `advisory-ai` a prerequisite of `release-evidence`; only a fresh release-gate pass can clear the blocker. |
| Downstream operational evidence | Target operations preflight and Base Sepolia token metadata references | Implemented locally | Added `backend:release:downstream:operations:evidence:check` and `verify-downstream-operational-evidence.mjs`. It validates separate redacted target-operations and token-metadata reports by exact commit, protected path, SHA-256, all preflight checks ready, chain ID `84532`, matched enabled token metadata, and immutable read-only fields. It reports evidence only and cannot clear dependent gates or grant authority. |
| Verifier/durable-operations evidence | Isolated recovery, fresh verifier/reconciliation, outbox, and idempotency evidence | Implemented locally | Added `backend:release:verifier:durable:operations:evidence:check` and `verify-verifier-durable-operations-evidence.mjs`. It validates `recovery_evidence`, `verifier_reconciliation_evidence`, and `durable_worker_evidence` references by exact commit, protected path, SHA-256, 19-migration isolated recovery, fresh verifier, zero-issue reconciliation, outbox health, worker readiness, idempotency cleanup, and immutable read-only fields. It reports evidence only and never clears a gate or grants authority. |
| Next hardening batch | Independent blocker-resolution fingerprint, smoke-phase2 evidence, and release-evidence reference validation | Implemented locally | Added `backend:release:blocker:resolution:fingerprint:check`, `backend:release:smoke:phase2:evidence:check`, and `backend:release:evidence:reference:check`; CI retains the blocker-resolution sidecar and fingerprint report. All outputs remain commit-bound, redacted, `releaseEligible: false`, `settlementAuthority: false`, and `mutation: read_only`. |
| Human worksheet binding | Exact release artifact binding for six shadow-review submissions | Implemented locally | `submit-shadow-review-decisions.mjs` now requires lowercase `releaseCommit` plus lowercase `artifactSha256`; submit mode requires matching `PAYTRAY_REVIEW_EXPECTED_COMMIT` and `PAYTRAY_REVIEW_EXPECTED_ARTIFACT_SHA256` before any network request. CLI coverage passes for six-run dry-run output, missing/malformed hashes, and commit/artifact mismatch guards. |

The BB/AW/BD/BF/BG/BH/BI/BJ/BL/BM/BN/BO/BP/BQ/BR/BS/BT/BU/BW/BX/BZ/CA/CB/CC/CD/CE/CF/CG/CH/CI/CK/CL/CM/CN/CO/CP/CQ/CR/CS/CT/CU/CV/CX/CY/DI/DJ/DK and current fingerprint/smoke/release-evidence hardening tranche now includes durable trust-signal, webhook inbox, durable-hook, worker, OpenAPI, SDK, housekeeping-schedule, target-operations-preflight, verifier-worker, CI, and HTTP hardening coverage; the latest previous validation passed **85 test files and 377 tests**, while the current hardening validation passes **87 test files and 385 tests**, and remote workflow `32059892697` completed with all six jobs successful, ESLint, migration code validation through migration 019, the runtime-to-OpenAPI contract verifier, a 100-event simulated webhook delivery/replay-load test, exact outbound HMAC digest tests, malformed/tampered signature rejection, timestamp skew rejection, replay detection and expiry coverage, durable idempotency cleanup tests, PostgreSQL replay-claim tests, focused verifier-owned payment-state tests, durable outbox processor tests, extension-event contract tests, degraded-database API coverage, and isolated ready-PostgreSQL verification with 25 restored tables and 19 migrations plus `engagementPaymentState: true`, `extensionOpenApi: true`, `trustSignals: true`, `webhookInbox: true`, `outboxDryRun: true`, and worker configuration status `ready`; the latest release-gates job also captured and fingerprinted verifier-cursor evidence. The release manifest is read-only; the DK release-gate artifact contract requires the named `secret-manager-custody` check; production approval and signed-payload generation remain blocked by genuine environment and human-evidence requirements.

## 2. Mandatory release blockers

These are not code defects that can be safely bypassed by the agent. They require authenticated environment access, controlled operational work, or explicit human decisions.

| Priority | Blocker | Required evidence | Current state | Clear condition |
|---:|---|---|---|---|
| P0 | Railway target settings unavailable | Authenticated, redacted comparison of database, JWT, HTTPS RPC, protocol contract, token registry, webhook signing, verifier threshold, chain, and mainnet flag | Pending; settings were unavailable | Railway gate reports matched settings without exposing secrets. |
| P0 | Full database recovery not verified in the target release environment | Backup fingerprint, isolated database restore log, catalog/table verification, and application connectivity check | AU verified a disposable local restore; target-environment evidence remains pending | Target recovery evidence changes from `schema_catalog_only` to `verified`. |
| P0 | Durable verifier not fresh | HTTPS RPC configuration, worker startup, cursor persistence, bounded polling, finality threshold, and chain-event audit evidence | `not_configured` in checked environment | Verifier status classification is `fresh`. |
| P0 | Final reconciliation evidence | Durable report after a fresh cursor, including projection lag and ledger linkage | Local report was clean, but target evidence is not complete | Report status is `ok` with no unresolved issues. |
| P0 | Pending shadow reviews | Baseline comparison, sample/confidence evidence, rollback target, reviewer identity, notes, and decision for every pending run | Pending reviews remain | No blocking review remains; promotion stays `shadow_only`. |
| P0 | Four human sign-offs | Real identity, decision, timestamp, scope, rollback acknowledgement, notes, and evidence references | All four rows are `Pending` | Authorized reviewers approve the same immutable release commit and artifact. |
| P0 | Operator Ed25519 key | Key injected through an approved secret manager as `RELEASE_SIGNING_KEY_PEM` | Not provided and must not be fabricated | Signed payload has a non-null signature and detached verification exits 0. |

## 3. Exact release-clearance sequence

The sequence below is the master operator checklist. Each step must be completed with evidence before the release artifact is regenerated.

### Environment and deployment evidence

- [ ] Authenticate to the Railway project and select the intended non-production/trial service.
- [ ] Capture redacted settings only; never copy secrets into reports or Git.
- [ ] Confirm `SETTLEMENT_CHAIN_ID=84532` and `PAYMENT_MAINNET_ENABLED=false` for the first release.
- [ ] Confirm the configured Sablier Flow v3 Base Sepolia contract.
- [ ] Confirm every enabled token has the correct chain, checksum address, protocol contract, symbol, and decimals.
- [ ] Confirm `PAYMENT_RPC_URL` is HTTPS and points to the approved Base Sepolia provider.
- [ ] Confirm webhook signing, verifier threshold, JWT, database, and operator scopes.
- [ ] Confirm durable outbox health reports `status: ok`, with no dead-letter events and bounded retry backlog.
- [ ] Run `npm run backend:outbox:health:check` and preserve its read-only evidence.
- [ ] Run `npm run backend:railway:trial:check` and obtain a matched settings result.

### Database and verifier evidence

- [ ] Run `DATABASE_URL="$DATABASE_URL" npm run backend:migrations:check` in the target environment.
- [ ] Create a protected PostgreSQL backup and record its SHA-256 fingerprint.
- [ ] Restore into a separate isolated database; never overwrite the source database during verification.
- [ ] Verify all PayTray tables, indexes, migration records, and required columns after restore.
- [ ] Run a read-only application connectivity check against the restored database.
- [ ] Start the configured verifier worker with bounded polling and the approved finality threshold.
- [ ] Verify the durable cursor is persisted and classified `fresh`.
- [ ] Preserve chain-event audit evidence for the scan and any replay/reorg decisions.
- [ ] Run the durable reconciliation report after the cursor is fresh.
- [ ] Resolve every finalized-without-ledger, unlinked-event, transaction-evidence, and projection-lag issue before proceeding.

### AI, data, and collaboration evidence

- [ ] Export the candidate-versus-baseline ranking evaluation.
- [ ] Verify sample size, confidence lower bound, segment evidence, and rollback target.
- [ ] Review every pending shadow run with a real reviewer identity and decision.
- [ ] Keep candidate ranking permanently `shadow_only` until a separate explicit promotion process exists.
- [ ] Verify discovery lineage from impression to engagement to verified outcome using `GET /api/v2/ops/discovery/lineage`.
- [ ] Verify collaboration-AI provenance, retention, latency, cost, raw-content exclusion, and human override.
- [ ] Confirm no AI output can mutate payment, ledger, outcome, reputation, or settlement state.
- [ ] Run `npm run backend:advisory:ai:check` and confirm provider/model budgets, retrieval cap, retention, raw-content exclusion, and `shadow_only` status.
- [ ] Confirm every advisory-AI provider response is provenance-bound, cost/latency-bounded, human-reviewable, and non-authoritative.

### Security, platform, and smoke evidence

- [ ] Run wallet challenge/signature/session authorization tests.
- [ ] Review operator scope boundaries and administrative endpoints.
- [ ] Confirm webhook SSRF protections, delivery-time DNS revalidation, signing, bounded retry, and dead-letter handling.
- [ ] Confirm the private signing key is absent from Git, logs, payloads, and reports.
- [ ] Verify the public-key fingerprint through an independent security review.
- [ ] Run rate-limit, secret-handling, audit-log, and incident-rollback checks.
- [ ] Run the no-live-funds smoke path: discovery → engagement → payment intent → verifier-read-only status.
- [ ] Run `READY_POSTGRES_DATABASE_ISOLATED=true npm run backend:ready:postgres:check` against an explicitly isolated target and preserve `status: verified` evidence.
- [ ] Run `GET /api/v2/collaboration/health` under payment/verifier degradation and confirm collaboration remains available with `paymentStateMayBeStale: true`.
- [ ] Confirm no smoke test claims settlement before verifier-owned chain evidence.
- [ ] Verify v2 extension hooks use allowlisted events, bounded projections, signed/retryable delivery, and forbidden raw-content exclusion.

### Release artifact and approval evidence

- [ ] Run `npm run test` and record the exact test summary.
- [ ] Run `npm run lint`.
- [ ] Run migration validation through migration 019, including `MIGRATION_015_CONTRACT_ISOLATED=true npm run backend:release:migration:015:check`.
- [ ] Run `npm run backend:release:manifest:check` on the immutable clean commit.
- [ ] Run `DATABASE_URL="$DATABASE_URL" npm run backend:release:approval:check`.
- [ ] Confirm approval artifact `status: ready` and `eligible: true`.
- [ ] Obtain the real four-reviewer approval records.
- [ ] Inject `RELEASE_SIGNING_KEY_PEM` from the approved secret manager.
- [ ] Run `npm run backend:release:payload:check`.
- [ ] Run `npm run backend:release:payload:verify /protected/path/signed-release-payload.json`.
- [ ] Confirm detached verification returns `status: verified` and exit code `0`.
- [ ] Preserve the signed artifact, public-key fingerprint, manifest hash, approval artifact, and reviewer evidence bundle.

## 4. Four mandatory reviewer records

| Reviewer | Required decision | Required identity fields | Required evidence focus |
|---|---|---|---|
| Release operator | `approved: true` | `reviewerId`, `approvedAt`, `scope: production_release`, `rollbackAcknowledged: true` | Commit, clean worktree, Railway match, rollback, smoke test, signed artifact |
| Protocol/finance reviewer | `approved: true` | Same required fields | Chain/contract/token/decimals, verifier freshness, migration/restore, reconciliation |
| AI/data reviewer | `approved: true` | Same required fields | Baseline, sample/confidence, outcome lineage, shadow queue, provenance, rollback |
| Security reviewer | `approved: true` | Same required fields | Auth, scopes, SSRF/DNS, secrets, key custody, fingerprint, audit logs |

Use the detailed YAML/JSON form in `docs/secure-release-key-and-reviewer-signoff-template.md`. The following values are the minimum approval schema and are invalid until replaced with real evidence:

```json
{
  "approved": true,
  "reviewerId": "<real authorized reviewer identity>",
  "approvedAt": "<real ISO-8601 timestamp>",
  "scope": "production_release",
  "rollbackAcknowledged": true
}
```

## 5. Remaining engineering backlog after BD/BB

The items below are the next build sequence. They are deliberately separated from environment-controlled release blockers; code can be implemented, but production readiness still depends on real target evidence.

| Proposed batch | Scope | Priority | Exit condition |
|---|---|---:|---|
| AU | Isolated database restore runner and machine-verifiable recovery artifact | Completed locally | Disposable restore is reproducible, fingerprinted, and classified `verified`; target-environment restore remains a release gate. |
| AV | Verifier operations evidence bundle: cursor freshness, worker health, bounded scan, replay/reorg counters, and operator export | Completed locally | CLI and endpoint are implemented; current local result is blocked `not_configured` until the target RPC worker and fresh cursor exist. |
| AW | Integration contract tests for `/api/v2/ops/audit/events`, `/api/v2/ops/discovery/lineage`, release approval, and verifier status with a ready PostgreSQL fixture | Completed locally | Scope and degraded-database contracts are covered; ready-PostgreSQL route fixtures remain a follow-up test-environment task. |
| AX | Read-only on-chain token metadata probe for configured ERC-20 `decimals`, symbol, chain, and contract consistency | Completed locally | Probe and mismatch tests pass; target RPC evidence remains pending. |
| AY | Durable outbox and operator delivery health for audit/lineage/reconciliation evidence | Completed locally | Verifier API and worker projections enqueue durable events; health/event endpoints expose retry, lease, failure, and dead-letter states without financial mutation. |
| AZ | Discovery evaluation export extension using the new lineage endpoint and verified outcome labels | Completed locally | Export now includes lineage status, ranking position, outcome IDs, coverage counts, and `rawContentIncluded: false`. |
| BA | Advisory AI provider/retrieval boundary with provenance, cost, latency, and human override | Completed locally | Provider contract, content-free retrieval references, source-event provenance, retention, latency/cost budgets, human review, and no-settlement authority are enforced. |
| BB | Collaboration provider health/degraded-state surface | Completed locally | `/api/v2/collaboration/health` separates collaboration availability from payment/verifier/indexer degradation; core store/auth failures block while payment degradation does not. |
| BC | Controlled Base Sepolia smoke harness with zero-live-funds guardrails | Completed locally | Harness refuses non-isolated databases, non-Base-Sepolia policy, missing enabled token registry, and chain mutations; disposable target execution remains operator-run. |
| BD | Public API and extension contract documentation with versioning and scope matrix | Completed locally | v2 operations, lineage, verifier, recovery, token metadata, smoke, and public extension schemas are documented; BP adds the public OpenAPI document and dependency-free SDK surface. |
| BI | Ready-PostgreSQL BG/BH verification and webhook signature security | Pushed | Ready verification now creates only disposable engagement fixtures and calls BG/BH read-only paths; BF reviewer writes remain excluded. HMAC-SHA256 uses exact body binding, bounded `WEBHOOK_SIGNATURE_TOLERANCE_MS`, and replay-key protection through the shared verifier. |
| BJ | End-to-end webhook replay-load validation and shared durable-store guidance | Pushed | The isolated test delivered 100 events through captured callbacks, independently verified each signature, and rejected all 100 duplicate replay attempts. Production horizontal scaling still requires a shared atomic replay/inbox store; the in-process guard is not treated as sufficient. |
| BK | Shadow-review approval and isolated-recovery operator runbook | Implemented locally | Non-submitting `approved_pilot` templates, post-submit audit verification, isolated restore commands, and exact 19-migration evidence requirements. |
| BL | Durable idempotency expiry cleanup and shared webhook replay claims | Pushed | Expired idempotency records are removed in bounded `FOR UPDATE SKIP LOCKED` batches; migration 014 provides an atomic PostgreSQL replay barrier and signature-before-claim verifier boundary. |
| BF | Durable reviewer-decision audit records | Pushed | New and replayed human shadow-review decisions are written as operator audit evidence in the same transaction; notes are hashed rather than copied, outbox events are queued, and responses remain `shadow_only`. |
| BG | Engagement payment-state surface | Pushed | The authenticated participant can read verifier/ledger-owned lifecycle, finality, payment status, cursor freshness, and `paymentStateMayBeStale` without blocking collaboration. |
| BH | Outbox delivery processor | Pushed | Operators can dry-run or process due durable events to matching v2 hooks with SSRF-safe signed delivery, bounded retry, dead-letter evidence, and no settlement authority. |
| BE | Multi-chain expansion | Deferred | Only consider after single-chain reliability targets, reconciliation SLOs, and incident rollback evidence are met. |

The safest remaining engineering order is **target evidence for AU/AV/AX/BC/AY/BA/BI/BL/BM/BN/BO/BP/BQ/BR/BS/BT/BU/BW/BX/BZ/CA/CB/CC/CD/CE/CF → authenticated Railway target verification → verifier, outbox, and housekeeping activation**, while **BE remains intentionally deferred**.
 The user-visible product can advance through discovery, collaboration, and Base Sepolia time-to-money flows without pretending that multi-chain or autonomous AI promotion is production-ready.

## 6. Current release commands

```bash
cd /home/ubuntu/projects/PAYTRAY

git status --short
git rev-parse HEAD
npm run backend:quality:check
npm run test
npm run lint
DATABASE_URL="$DATABASE_URL" npm run backend:migrations:check
MIGRATION_009_CONTRACT_ISOLATED=true DATABASE_URL="$DATABASE_URL" npm run backend:release:migration:009:check
MIGRATION_010_CONTRACT_ISOLATED=true MIGRATION_010_CONCURRENCY_ATTEMPTS=4 MIGRATION_010_CONCURRENCY_REPETITIONS=3 DATABASE_URL="$DATABASE_URL" npm run backend:release:migration:010:check
npm run backend:deployment:check
npm run backend:recovery:check
RECOVERY_ARTIFACT_ISOLATED=true npm run backend:release:recovery:artifact:check -- --sidecar artifacts/recovery-evidence.sha256
MIGRATION_015_CONTRACT_ISOLATED=true DATABASE_URL="$DATABASE_URL" npm run backend:release:migration:015:check
npm run backend:verifier:operations:check
npm run backend:outbox:health:check
npm run backend:idempotency:cleanup:check
npm run backend:target:operations:check
npm run backend:operations:quality:check
RELEASE_GATES_STRICT=false npm run backend:release:gates:check
DATABASE_URL="$DATABASE_URL" npm run backend:ops:evidence:bundle:check
npm run backend:ops:evidence:bundle:verify /protected/evidence/paytray-evidence-bundle-<COMMIT>.json
# CI also runs the operations-quality command in a separate non-strict job.
npm run backend:verifier:worker:check
npm run backend:sdk:contract:check
npm run backend:release:evidence:check
DATABASE_URL="$DATABASE_URL" npm run backend:reconciliation:evidence:check
VERIFIER_OPERATIONS_FILE=/protected/evidence/verifier-operations-<COMMIT>.json \
RECONCILIATION_EVIDENCE_FILE=/protected/evidence/reconciliation-<COMMIT>.json \
VERIFIER_RECONCILIATION_EVIDENCE_TARGET=authenticated_target \
npm run backend:release:verifier-reconciliation:evidence:check
VERIFIER_OPERATIONS_FILE=/protected/evidence/verifier-operations-<COMMIT>.json \
VERIFIER_CURSOR_EVIDENCE_TARGET=authenticated_target \
npm run backend:release:verifier:cursor:evidence:check
curl -H "Authorization: Bearer $OPS_ACCESS_TOKEN" "$PAYTRAY_BASE_URL/api/v2/ops/evidence"
curl -H "Authorization: Bearer $OPS_ACCESS_TOKEN" "$PAYTRAY_BASE_URL/api/v2/ops/release-evidence"
curl -H "Authorization: Bearer $OPS_ACCESS_TOKEN" "$PAYTRAY_BASE_URL/api/v2/ops/reconciliation/evidence"
npm run backend:advisory:ai:check
READY_POSTGRES_DATABASE_ISOLATED=true npm run backend:ready:postgres:check
npm run backend:token:metadata:check
npm run backend:smoke:phase2:check
npm run backend:railway:trial:check
DATABASE_URL="$DATABASE_URL" npm run backend:release:approval:check
npm run backend:release:manifest:check
npm run backend:release:payload:check
npm run backend:release:payload:verify /protected/path/signed-release-payload.json
```

The last two commands must remain blocked until real approval, Railway, migration/recovery, and signing-key evidence are available. A blocked result is the correct security outcome, not a reason to weaken the gate.

### Migration-002 financial-core contract hardening batch

| Scope | Status | Evidence |
|---|---|---|
| Eight financial-core tables, fifteen payment-stream columns, protocol stream identity, payment-intent idempotency and transaction-hash uniqueness, chain-event identity, ledger provenance, ledger-account/idempotency-record uniqueness, outbox attempts, financial-audit actor domains, and four bounded duplicate-write races | Implemented and locally verified | `migration-002-verifier-local.json`; isolated/restored CI and recovery checksum wiring added |

The verifier covers valid round-trips plus exact SQLSTATE `23505` duplicate boundaries and SQLSTATE `23514` state, amount, provenance, and actor negatives. It remains disposable engineering evidence with `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.

### Migration-004/005 contract hardening batch

| Migration | Scope | Status | Evidence |
|---|---|---|---|
| 004 engagement context | Six non-null context/status/version columns, JSONB/status/version defaults, two named status CHECKs, two indexes, invalid/null status and context negatives, bounded optimistic-update race | Implemented and locally verified | `migration-004-verifier-local.json`; isolated/restored CI and recovery checksum wiring added |
| 005 outcome lineage | Outcome table columns, enum CHECKs, JSONB defaults, unverified default, engagement FK, indexes, four-field identity uniqueness, duplicate/enum/FK/null negatives, duplicate identity race, verifier-owned transition race | Implemented and locally verified | `migration-005-verifier-local.json`; isolated/restored CI and recovery checksum wiring added |

Migration-004 race losers are classified as safe `optimistic_update_conflict` no-ops; migration-005 transition losers are persisted-state no-ops after row locking. Both reports remain disposable engineering evidence with `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`.

### Migration-006/007/008 contract hardening batch

| Migration | Scope | Status | Evidence |
|---|---|---|---|
| 006 AI evaluation foundation | AI table/index catalogs, shadow-only defaults, evaluation-example uniqueness, confidence/applied-state checks, bounded duplicate-example races | Implemented and locally verified | `migration-006-verifier-local.json`; isolated/restored CI wiring staged for this batch |
| 007 discovery impressions | Discovery-impression indexes, rank/score CHECKs, query/candidate uniqueness, JSONB defaults, bounded duplicate-impression races | Implemented and locally verified | `migration-007-verifier-local.json`; isolated/restored CI wiring staged for this batch |
| 008 production telemetry | Telemetry column/index catalog, event/privacy CHECKs, JSONB defaults, event-id uniqueness, bounded duplicate-event races | Implemented and locally verified | `migration-008-verifier-local.json`; isolated/restored CI wiring staged for this batch |

Each new verifier rejects unsafe/non-disposable database targets, uses bounded concurrency, rolls back and releases failed transactions, performs dependency-ordered cleanup, and reports immutable false/read-only authority fields. Local results are engineering evidence only.

### Migration-009/010 contract hardening batch

| Migration | Scope | Status | Evidence |
|---|---|---|---|
| 009 verified-outcome provenance | Verification columns, verified-outcome index, default null state, metadata round-trip, invalid status and oversized hash negatives | Implemented and locally verified | `migration-009-verifier-local.json`; isolated/restored CI and recovery checksum wiring added |
| 010 ledger intent idempotency | Partial `(source_intent_id, entry_type)` uniqueness, source-provenance CHECK, duplicate/missing-provenance negatives, distinct entry type, bounded concurrent duplicate races | Implemented and locally verified | `migration-010-verifier-local.json`; 4 attempts × 3 repetitions, one winner and three `23505` losers per race |

Migrations-021/022 remain **not present**. No SQL source, runtime contract, verifier, package command, CI step, recovery allowlist entry, or approved product/data contract exists for either version. Do not fabricate them; begin that tranche only after approved source contracts are available.

## References

[1]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/MasterBlueprint.md MasterBlueprint roadmap and architecture

[2]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/docs/final-production-release-checklist.md Final production release checklist

[3]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/docs/secure-release-key-and-reviewer-signoff-template.md Secure key and reviewer template

[4]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/packages/backend/lib/auditLogService.js Batch AR audit service

[5]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/packages/backend/lib/discoveryLineageService.js Batch AT lineage service

## 7. Liveness/readiness hardening batch

| Batch | Scope | Status | Evidence |
|---|---|---|---|
| Liveness/readiness split | Process-only `/livez` and `/api/health/liveness`; strict `/readyz` and `/api/health/readiness`; `Cache-Control: no-store`; immutable safety fields | Implemented locally, included in this batch validation | Liveness does not query dependencies or grant authority. Focused route/helper tests now verify HTTP status mapping, no-store responses, dependency checks, and false/read-only readiness authority fields. |

The liveness endpoints are health evidence only. They do not clear migration, Railway, verifier, target, advisory-AI, shadow-review, sign-off, custody, approval, manifest, payload, or release-authority blockers.

## 8. Next release-cycle planning and CI modernization

| Batch | Scope | Status | Evidence |
|---|---|---|---|
| Release-cycle planning simulation | Deterministic engineering lead-time plan for CI modernization, dependency refresh, probe observability, warning tracing, performance telemetry, warning governance, and pipeline conformance | Planning-only | 18 modeled working days on the stated dependency graph; modeled operator-blocker resolution rate remains 0%. |
| CI runner/action modernization | Upgrade GitHub Actions checkout/setup-node references from v4 to v5 and upload-artifact references from v4 to v7 while preserving Node 22 application runtime and all existing job contracts | Implemented locally, pending CI | Must verify all six CI jobs, action deprecation warnings, test counts, artifact fingerprints, and immutable safety fields. |

Simulation output is not release evidence and cannot clear migrations, Railway, target, verifier, AI, human-review, custody, approval, manifest, payload, or authority blockers.

## 9. Telemetry performance observability hardening

| Batch | Scope | Status | Evidence |
|---|---|---|---|
| Bounded telemetry performance metrics | Add sample count, minimum-sample sufficiency, aggregate p95 ingestion lag, configured target comparison, and immutable read-only safety fields without changing release or settlement authority | Implemented locally, pending validation | Focused telemetry and release-readiness tests must preserve 394-test baseline or improve it; insufficient samples report `withinTarget=null`. |

Telemetry performance metrics are diagnostic context only. They cannot clear operational blockers, substitute for authenticated target evidence, promote AI ranking, or grant payment, deployment, settlement, or release authority.

## 10. PostgreSQL recovery timing and RTO evidence

| Batch | Scope | Status | Evidence |
|---|---|---|---|
| Phase-bound recovery timing | Measure backup, backup-integrity, catalog, restore, and restored-database verification phases; validate optional operator RTO target consistency; preserve isolated recovery-only authority | Implemented locally, pending full validation and CI | `RECOVERY_RTO_TARGET_MS` is optional; absent target yields `withinTarget=null`. Existing 173a017 run had 71-second recovery job wall-clock duration but no phase-bound RTO result. |

Recovery timing is engineering evidence only. It does not establish production RTO, clear the recovery blocker, grant release authority, or authorize production database restoration.
