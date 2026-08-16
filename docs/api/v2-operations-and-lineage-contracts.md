# PayTray v2 Operations and Lineage API Contracts

**Version:** `v2`

**Authority boundary:** All operations described here are read-only evidence or explicitly scoped verifier actions. API, AI, chat, and participant reports do not establish settlement. Only verifier-owned chain evidence and the durable ledger establish economic truth.

## Authentication and scope

Every `/api/v2/ops/*` route requires a valid PayTray access token with the `ops:*` scope. Ordinary wallet sessions and profile-only tokens must receive `403`. A valid operator token must receive an explicit database-service error when PostgreSQL is unavailable; the endpoint must not silently return an empty or fabricated report.

## `backend:target:operations:check`

This read-only CLI composes the deployment preflight, redacted Railway trial settings comparison, Base Sepolia policy, HTTPS payment RPC, explicit verifier-worker and durable outbox-worker opt-ins, and idempotency-housekeeping schedule configuration. It reports `status: ready` only when those configuration checks match, but it always emits `releaseEligible: false`: configuration is not a substitute for a fresh durable verifier cursor, target backup-restore evidence, reconciliation evidence, human shadow-review decisions, four reviewer sign-offs, or an operator signing key. The command performs no Railway API call, deployment, database migration, chain transaction, settlement mutation, or secret export. Without explicit target settings and operational opt-ins, it exits nonzero with named blockers rather than inferring readiness.

The Railway trial report may also include `railwayMetadata` containing only operator-supplied non-secret `projectName`, `environmentName`, and allowlisted `web`/`worker` service statuses (`running`, `offline`, `deploying`, `failed`, `crashed`, `sleeping`, or `unknown`). Complete metadata is marked `status: 'observed'`; missing fields are `metadata_unavailable`. The report never queries Railway, opens secrets, infers environment variables, performs deployment, or changes `releaseEligible: false`, `settlementAuthority: false`, or `mutation: 'read_only'`.

## `backend:verifier:worker`

This explicit production entrypoint is the only supported continuous chain-verifier process for the current single-chain deployment. It requires `VERIFIER_WORKER_ENABLED=true`, `DATABASE_URL`, an HTTPS `PAYMENT_RPC_URL`, the configured Sablier Flow v3 Base Sepolia contract, a matching enabled token registry, `SETTLEMENT_CHAIN_ID=84532`, and `PAYMENT_MAINNET_ENABLED=false`. Each bounded poll runs with a dedicated PostgreSQL transaction, persists the verifier cursor only after event processing, emits verifier-owned audit/outbox evidence, and never treats a wallet intent or API response as settlement. SIGTERM and SIGINT stop future polling and close the database cleanly.

`backend:verifier:worker:check` is read-only. It verifies configuration and reports the poll interval, block range, finality threshold, verifier identifier, cursor persistence table, and projection boundary without starting the worker or contacting the chain. The worker is not a release-approval mechanism and cannot approve shadow runs or promote AI ranking.

## `backend:quality:check` and CI

`backend:quality:check` is the shared deterministic developer/CI gate for the full test suite, ESLint, the runtime-to-OpenAPI contract verifier, and whitespace validation. `.github/workflows/paytray-quality.yml` runs it on protected branch pushes and pull requests, then runs migration and ready-PostgreSQL route-contract checks against an isolated PostgreSQL 16 service. CI uses only disposable credentials and no live-chain mutation path.

## HTTP and rate-limit hardening

The server applies a configurable bounded body limit to JSON and URL-encoded requests through `REQUEST_BODY_LIMIT` and requires explicit `TRUST_PROXY=true` before Express resolves forwarded client addresses. Rate-limit state evicts expired keys and enforces `RATE_LIMIT_MAX_KEYS`; these controls limit memory growth without changing payment authority, authentication scopes, or financial state transitions.

## `backend:sdk:contract:check`

This read-only verifier cross-checks the dependency-free `@paytray/sdk` runtime against the v2 OpenAPI document and extension capability module. It captures the three documented SDK request paths using a local fetch stub, verifies operation IDs and safety metadata, checks the v2 registration default, and scans the TypeScript declarations for the client and immutable safety properties. It performs no network access, database mutation, deployment, settlement mutation, or approval.

## `backend:release:evidence:check`

This read-only CLI aggregates target-operations configuration, deployment preflight, database readiness, verifier freshness/linkage, reconciliation, durable outbox health, webhook-inbox health, pending shadow-review count, rollback-target evidence, human sign-off evidence, and redacted signing-key presence. It produces named blockers and never includes private key material. Its output always contains `releaseEligible: false`, `settlementAuthority: false`, and `mutation: 'read_only'`; a configuration or evidence-complete report is not a release approval and cannot submit a transaction or promote an AI candidate.

## `GET /api/v2/ops/runtime/health`

This authenticated operator endpoint composes request availability and p95 latency observations with database readiness, collaboration availability, verifier operations, durable outbox health, webhook-inbox health, telemetry status, and configured SLO thresholds. It requires a ready PostgreSQL database, returns `200` only when all observed checks are ready, and may return `503` with named degraded checks while still returning a structured report. Insufficient request samples are explicitly `not ready` rather than being treated as a healthy zero-data result. The report always states `paymentStateAuthority: 'verifier_and_ledger_only'`, `settlementAuthority: false`, `releaseEligible: false`, and `mutation: 'read_only'`. Payment/verifier degradation does not authorize settlement and must not block the collaboration surface itself.

## `backend:reconciliation:evidence:check`

This read-only command runs the durable reconciliation report against PostgreSQL and wraps the canonicalized report in a SHA-256 evidence hash plus the current Git commit boundary and issue count. It returns `status: verified` only when reconciliation reports `ok`; unresolved projection, lifecycle, ledger-linkage, or transaction-evidence issues produce `status: attention` and a nonzero exit. The command never changes streams, ledger entries, verifier cursors, settlement state, or release eligibility, and its output never includes secrets.

## Reviewer identity and cryptographic attestation

`POST /api/v2/ops/reviewer-attestations/challenge` requires `ops:*` and issues a short-lived server-bound challenge for one role, one release commit, one artifact SHA-256, one public-key fingerprint SHA-256, and one human decision (`approved` or `rejected`). The reviewer wallet is taken from the verified JWT wallet claim; the request cannot choose a different reviewer identity. The returned message contains a random nonce, issue/expiry timestamps, and all bound fields. Challenge issuance is not a sign-off, does not submit a review, and always emits `releaseEligible: false`, `settlementAuthority: false`, and `mutation: 'read_only'`.

`POST /api/v2/ops/reviewer-attestations/verify` accepts only the challenge ID and an EIP-191 signature. The server locks the challenge, rejects expired or consumed challenges, recomputes and compares the stored message hash, verifies the signature with `ethers.verifyMessage`, requires the recovered wallet to match both the challenge wallet and the authenticated JWT wallet, consumes the challenge once, and records a redacted append-only attestation. The stored signature is never returned by inspection endpoints. A verified attestation is cryptographic evidence binding a reviewer wallet to a role and artifact; it is not a release approval, AI promotion, payment mutation, or settlement authority.

`GET /api/v2/ops/reviewer-attestations` returns only redacted attestation metadata, including reviewer wallet, role, release commit, artifact hash, public-key fingerprint, attestation digest, decision, timestamps, and immutable safety fields. It excludes signature bytes and free-form reviewer notes. The migration-backed uniqueness rule permits at most one verified attestation per role and release commit. All three routes fail closed when PostgreSQL is unavailable and retain `submissionPerformed: false`, `releaseEligible: false`, `settlementAuthority: false`, `mutation: 'read_only'`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`.

## Operator evidence API endpoints

`GET /api/v2/ops/release-evidence` and `GET /api/v2/ops/reconciliation/evidence` expose the same evidence contracts to authenticated `ops:*` callers. Both require a ready PostgreSQL database, return structured `503` responses when evidence is incomplete or requires attention, and preserve the report body for diagnosis. The release-evidence response always has `releaseEligible: false`, while reconciliation evidence includes a deterministic `evidenceHash`; neither endpoint submits transactions, writes financial state, approves reviews, promotes AI ranking, or includes signing-key material.

`GET /api/v2/ops/evidence` is the consolidated read-only surface. It combines both reports into one response, includes a SHA-256 `evidenceFingerprint` over the safe evidence references, and returns `complete_pending_release_gate` only when the evidence is complete; it never changes `releaseEligible: false`, `settlementAuthority: false`, or `mutation: 'read_only'`. The shared `evidenceFingerprint.js` utility canonicalizes object keys before hashing so equivalent evidence ordering produces the same fingerprint.

## `GET /api/v2/ops/health/dashboard`

This authenticated operator endpoint aggregates the canonical runtime-health report, durable outbox health, durable webhook-inbox health, verifier-operations evidence, and unified operator evidence into one diagnostic response. It returns `200` only when all five components are healthy and evidence-complete; otherwise it returns `503` with the component summaries and named blockers intact. A missing PostgreSQL service fails closed as a database service error before any component is fabricated. The dashboard is explicitly `operator_health_aggregation_only`, keeps `paymentStateAuthority: 'verifier_and_ledger_only'`, and always emits `releaseEligible: false`, `settlementAuthority: false`, `mutation: 'read_only'`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`. It is an operator visibility surface only: it cannot start workers, process outbox events, alter verifier cursors, approve shadow reviews, promote AI ranking, submit transactions, or grant release authority.

## `backend:operations:quality:check`

This command runs ten existing read-only quality, migration, extension, SDK, verifier-worker, target-operations, release-evidence, reconciliation-evidence, canonical evidence-bundle, and release-gate checks and emits one machine-readable matrix. A successful check is classified as `passed`; missing target infrastructure or genuine operator evidence is classified as `operator_blocked` in normal mode rather than hidden or misreported as a code failure. Set `OPERATIONS_QUALITY_STRICT=true` in a fully configured release environment to treat every remaining blocker as a failure. The matrix never deploys, submits transactions, mutates settlement or ledger state, approves shadow reviews, promotes AI ranking, or marks a release eligible. When a PostgreSQL database is available, the CLI also appends a redacted run summary to `operations_quality_runs` with a canonical SHA-256 report hash. Audit persistence is best-effort for local runs without a database and never changes the matrix exit classification.

## `GET /api/v2/ops/release-gates/latest`

This authenticated `ops:*` endpoint returns the latest durable standalone `backend:release:gates:check` report recorded in `operations_quality_runs`. It selects only reports tagged `reportKind: 'release_gates'`, returns the redacted per-check matrix and canonical `report_hash`, and returns structured `503` with `status: 'not_recorded'` when no durable release-gate run is available. The endpoint is diagnostic only and always preserves `authority: 'operations_quality_audit'`, `mutation: 'read_only'`, `releaseEligible: false`, `settlementAuthority: false`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`; it cannot approve reviewers, promote AI ranking, change verifier cursors, mutate payment or ledger state, deploy, or grant release authority.

## `GET /api/v2/ops/operations-quality/runs`

This authenticated operator endpoint returns bounded summaries of durable operations-quality runs without returning the stored report payload. It supports an optional `status` filter, requires a ready PostgreSQL database, and returns `200` with `authority: 'operations_quality_audit'`, `mutation: 'read_only'`, `releaseEligible: false`, and `settlementAuthority: false`. The table is non-financial and append-only from the application path; listing it cannot rerun checks, mutate payment or ledger state, approve reviews, or grant release authority.

`backend:ops:evidence:bundle:verify <bundle.json>` independently recomputes the bundle’s canonical SHA-256 fingerprint and validates the bundle schema and immutable safety fields. A valid blocked bundle can verify successfully because verification proves artifact integrity, not release readiness. The verifier never approves reviewers, marks release eligibility, grants settlement authority, or submits transactions.

`GET /api/v2/ops/operations-quality/runs/:runId` returns one valid-UUID run and its stored redacted report, including the canonical `report_hash` and per-check classification. It returns `404` when no durable run exists and rejects malformed run identifiers before database lookup. The detail response retains `authority: 'operations_quality_audit'`, `mutation: 'read_only'`, `releaseEligible: false`, and `settlementAuthority: false`.

## `backend:release:key:custody:check`

This read-only verifier parses the injected Ed25519 private key only in process memory, derives its public key, compares it to the supplied public key, calculates the SHA-256 fingerprint of the exact public-key PEM, and checks that it matches the expected non-secret fingerprint. It also requires `RELEASE_SIGNING_KEY_SOURCE=approved-secret-manager`, a non-placeholder immutable `RELEASE_SIGNING_KEY_VERSION`, `RELEASE_SIGNING_KEY_PROTECTED=true`, `RELEASE_SIGNING_PUBLIC_KEY_FINGERPRINT_VERIFIED=true`, the exact release commit, and a security-role fingerprint attestation that matches both the public-key fingerprint and release commit. It never prints or returns key material, and blocked or verified output always preserves `releaseEligible: false`, `settlementAuthority: false`, and `mutation: 'read_only'`.

`backend:release:key:custody:check` is included in the release-gate matrix as `operator-key-custody`. Missing secret-manager injection, a mismatched derived public key, a mismatched fingerprint, a missing security attestation, or placeholder custody metadata is an expected `operator_blocked` result in normal mode and a failure in strict mode.

## `backend:release:gates:check`

This read-only CLI executes 20 release and validation checks, including migration, recovery, Railway, verifier, outbox, idempotency, target operations, approval, release evidence, reconciliation, manifest, payload, advisory-AI, token metadata, smoke, SDK, and extension contracts. When PostgreSQL is configured, it best-effort persists the redacted report with `reportKind: 'release_gates'` in the non-financial operations-quality audit table so operators can retrieve the latest result without rerunning checks through the API. In normal mode, absent target evidence, pending human approval, and unavailable protected recovery artifacts are classified as `operator_blocked`; unexpected implementation failures remain fatal. It emits `releaseEligible: false`, `settlementAuthority: false`, `mutation: 'read_only'`, `executedWithoutDeployment: true`, and `executedWithoutSettlementMutation: true`. The CI job stores only the redacted JSON matrix and its SHA-256 sidecar for operator inspection.

## `GET /api/v2/ops/audit/events`

Returns durable financial audit events from `financial_audit_events`. The route is paginated, filterable, and read-only. Sensitive metadata keys such as private keys, signatures, authorization headers, JWTs, passwords, and secrets are recursively redacted.

Shadow-review decisions are also durable financial audit evidence. A first decision emits `action: shadow_review_recorded` with `actorType: operator`, `entityType: ai_evaluation_run`, and a metadata envelope containing the decision, reviewer identifier, model/baseline context, a SHA-256 hash and length for reviewer notes, `applied: false`, `promotionStatus: shadow_only`, `authority: human_review_required`, and `mutation: read_only`. The same transaction enqueues a bounded outbox event (`ai.shadow_review_recorded`) carrying only redacted identifiers and decision evidence. Repeating the same terminal decision emits `action: shadow_review_replayed` and `ai.shadow_review_replayed`; conflicting decisions remain rejected. Reviewer note text is never copied into the financial audit event or outbox payload.

### Query parameters

| Parameter | Type | Range | Meaning |
|---|---|---:|---|
| `limit` | integer | 1–100 | Page size; default 50. |
| `offset` | integer | 0–100000 | Offset; default 0. |
| `actorType` | string | ≤32 | `verifier`, `ledger_worker`, `operator`, or other persisted actor type. |
| `actorId` | string | ≤255 | Actor identifier. |
| `action` | string | ≤128 | Exact audit action. |
| `entityType` | string | ≤64 | Persisted entity type. |
| `entityId` | string | ≤64 | Persisted entity identifier. |
| `correlationId` | string | ≤64 | Correlation identifier. |

### Response

```json
{
  "success": true,
  "audit": {
    "status": "ok",
    "authority": "financial_audit_events",
    "mutation": "read_only",
    "events": [
      {
        "id": "event-uuid",
        "actorType": "verifier",
        "actorId": "verifier-worker",
        "action": "payment_chain_event_projected",
        "entityType": "payment_stream",
        "entityId": "stream-uuid",
        "correlationId": "correlation-uuid",
        "metadata": {
          "chainEventId": "event-uuid",
          "projected": true,
          "privateKey": "[REDACTED]"
        },
        "createdAt": "2026-08-15T02:00:00.000Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "hasMore": false
    },
    "filters": {}
  }
}
```

## `GET /api/v2/ops/discovery/lineage`

Returns ranking provenance from discovery impression to engagement and outcome evidence. It intentionally excludes `query_features`, `match_explanation`, message content, transcripts, recordings, and other raw collaboration content.

### Query parameters

| Parameter | Type | Range | Meaning |
|---|---|---:|---|
| `queryId` | string | ≤255 | Discovery query identifier. |
| `candidateProfileId` | string | ≤64 | Candidate profile identifier. |
| `verificationStatus` | enum | `verified`, `unverified`, `rejected` | Filters by outcome verification status. |
| `limit` | integer | 1–100 | Page size; default 50. |
| `offset` | integer | 0–100000 | Offset; default 0. |

### Response

```json
{
  "success": true,
  "lineage": {
    "status": "ok",
    "authority": "verified_outcome_lineage",
    "mutation": "read_only",
    "rawContentIncluded": false,
    "impressions": [
      {
        "impressionId": "impression-uuid",
        "queryId": "query-uuid",
        "candidateProfileId": "profile-uuid",
        "engagementId": "engagement-uuid",
        "rankPosition": 1,
        "rankingVersion": "weighted-explainable-v1",
        "selected": true,
        "observedAt": "2026-08-15T02:00:00.000Z",
        "provenance": {
          "source": "discovery_v2",
          "rankingVersion": "weighted-explainable-v1"
        },
        "lineageStatus": "verified_outcome",
        "outcomes": [
          {
            "id": "outcome-uuid",
            "eventType": "meeting_completed",
            "evidenceType": "session",
            "evidenceId": "session-uuid",
            "verificationStatus": "verified",
            "occurredAt": "2026-08-15T02:30:00.000Z"
          }
        ]
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "hasMore": false
    }
  }
}
```

`lineageStatus` is one of `unlinked`, `engaged_no_outcome`, `verified_outcome`, `unverified_outcome`, or `rejected_outcome`. A verified outcome is a label candidate for evaluation; it is not an instruction to promote a model or mutate payment state.

## `GET /api/v2/collaboration/health`

Returns collaboration availability independently from payment and verifier health. A degraded payment RPC, stale verifier cursor, or unavailable indexer sets `paymentStateMayBeStale: true` and `mode: collaboration_available_payment_degraded`, but does not block messaging or engagement context. Durable engagement storage or session authorization failures block collaboration and return `503`. Realtime transport degradation is visible but does not grant payment authority.

```json
{
  "success": true,
  "health": {
    "status": "degraded",
    "ready": true,
    "collaborationAvailable": true,
    "mode": "collaboration_available_payment_degraded",
    "paymentStateAuthority": "verifier_and_ledger_only",
    "paymentStateMayBeStale": true,
    "settlementAuthority": false,
    "mutation": "read_only"
  }
}
```

## `GET /api/v2/engagements/:engagementId/payment-state`

Returns the authenticated participant's verifier-owned payment read model without making collaboration availability depend on the payment provider or chain latency. The response surfaces both the exact contract fields (`lifecycle_state`, `finality_status`, and `payment_status`) and camelCase aliases used by existing clients. `paymentStateMayBeStale: true` means the payment projection has no fresh verifier cursor for the relevant chain; it does not claim a failed payment and does not block messaging or engagement context.

```json
{
  "success": true,
  "source": "verifier_owned_payment_state",
  "paymentState": {
    "engagementId": "engagement-uuid",
    "lifecycle_state": "chain_finalized",
    "finality_status": "finalized",
    "payment_status": "ledger_reflected",
    "paymentStateMayBeStale": false,
    "verifierCursorStatus": "fresh",
    "paymentStateAuthority": "verifier_and_ledger_only",
    "settlementAuthority": false,
    "mutation": "read_only"
  }
}
```

When no payment has been requested, the endpoint returns `payment_status: not_requested` and `verifierCursorStatus: not_required`. A missing or stale cursor is explicit operational evidence, not a settlement transition.

## `POST /api/v2/ops/outbox/process`

Processes due durable `outbox_events` under `ops:*`. `dryRun` defaults to `true` and performs a read-only candidate plan without leasing or mutating events. With `dryRun: false`, due events are leased using `FOR UPDATE SKIP LOCKED`, delivered only to matching versioned v2 extension hooks, marked processed after all matching callbacks succeed, or recorded as failed with bounded exponential retry and dead-letter classification. Callback URL validation and delivery-time DNS revalidation remain mandatory. When configured, signed payloads use HMAC-SHA256 over the exact string `timestamp + "." + body`, emit `v1=<hex-digest>`, and carry a stable per-event/per-hook identifier for consumer replay protection. The shared verifier rejects malformed signatures, signatures outside `WEBHOOK_SIGNATURE_TOLERANCE_MS`, and duplicate replay keys within the bounded replay window.

The response is always explicit about `authority: durable_outbox_delivery`, `settlementAuthority: false`, and `settlementMutationPerformed: false`. Delivery failure cannot establish, reverse, or infer payment settlement. Reviewer-audit outbox events are allowlisted as `ai.shadow_review_recorded` and `ai.shadow_review_replayed`; their projections exclude reviewer note text and other forbidden raw content.

`WebhookReplayGuard` is a bounded in-process verifier primitive for development and focused tests. It is not a horizontally scaled production replay store. Consumers operating multiple instances must implement the atomic shared claim contract described in [`webhook-replay-store-integration.md`][11], preserve signature-before-claim ordering, fail closed when the store is unavailable, and use a durable inbox/idempotency record for crash-safe processing.

## `GET /api/v2/ops/trust-signals`

Returns verifier-owned durable trust signals derived only from outcomes whose verification status is `verified`, provenance source is `verifier`, and evidence hash is present. The response is read-only, permanently `eligibleForRanking: false`, `promotionStatus: shadow_only`, and `settlementAuthority: false`. Positive signals are participant-specific; verified dispute evidence is neutral and cannot create a negative reputation score. Unverified participant reports, rejected outcomes, and unsupported outcome types derive no signal.

## Durable webhook inbox

Migration `016_webhook_inbox` defines the downstream consumer state machine: `claimed`, `processed`, `retryable`, and `quarantined`. Signature verification and timestamp checks must complete before an inbox claim. Processed or quarantined duplicates are not re-executed; expired claims can be reclaimed with bounded attempts; max-attempt failures become quarantined. Payloads reject raw collaboration content and secrets. Inbox state is downstream delivery evidence only and cannot establish payment settlement.

## Production outbox worker

`backend:outbox:worker` is an explicit production entrypoint. It requires `OUTBOX_WORKER_ENABLED=true`, a ready PostgreSQL database, and `WEBHOOK_SIGNING_SECRET`. It loads active v2 hooks from durable migration `017_extension_hooks`, runs the existing bounded outbox processor with `OUTBOX_WORKER_BATCH_SIZE`, `OUTBOX_WORKER_LEASE_MS`, `OUTBOX_WORKER_POLL_INTERVAL_MS`, and `OUTBOX_WORKER_TIMEOUT_MS`, and stops cleanly on SIGTERM/SIGINT. The worker uses at-least-once bounded retry semantics and has no settlement authority.

## `backend:idempotency:cleanup`

Runs bounded expiry housekeeping for durable `idempotency_records` in a PostgreSQL transaction. Migration 015 verified trust signals, 016 webhook inbox, and 017 durable extension hooks are separate state boundaries and are never removed by this command. The command deletes only records with `expires_at <= now`, uses `FOR UPDATE SKIP LOCKED`, and caps each batch at 5,000 rows. It reports `authority: idempotency_housekeeping`, `settlementAuthority: false`, and `settlementMutationPerformed: false`; it cannot create, reverse, or infer payment settlement. Set `IDEMPOTENCY_CLEANUP_BATCH_SIZE` for a smaller bounded batch and use `IDEMPOTENCY_CLEANUP_NOW` only for isolated deterministic verification.

`backend:idempotency:cleanup:run` is the explicit production entrypoint. It requires `IDEMPOTENCY_CLEANUP_ENABLED=true`, `DATABASE_URL`, valid production configuration, and rejects `IDEMPOTENCY_CLEANUP_NOW` in production. `backend:idempotency:cleanup:check` is read-only and emits the external-host schedule contract, defaulting to a 15-minute interval and a 500-record batch; target hosting should invoke the run command from its scheduler rather than starting an in-process timer. Concurrent invocations remain bounded by PostgreSQL row locks and `SKIP LOCKED`, and every result remains non-settling housekeeping evidence.

For horizontally scaled webhook consumers, migration `014_webhook_replay_claims` provides the durable `webhook_replay_claims` primary-key barrier and expiry index. `verifyWebhookSignatureWithPostgresReplayStore` performs exact-body HMAC and timestamp verification before an atomic insert-or-expired-row-update claim. Store errors fail closed. The process-local `WebhookReplayGuard` remains suitable for focused tests and single-process development only; it is not the production multi-instance replay store.

## `GET /api/v2/extensions/openapi.json`

Returns the public, versioned OpenAPI 3.1 document for the v2 extension surface without authentication. The document is generated from the runtime contract capabilities, pins callback URLs to HTTPS, enumerates the supported event and projection sets, and includes `x-paytray-safety` metadata declaring `settlementAuthority: false`, `mutation: read_only`, `rawContentPersistence: false`, and `aiPromotion: shadow_only`. The document describes schemas only; it does not grant extension or operator access.

## `@paytray/sdk`

The workspace package `@paytray/sdk` provides a dependency-free Node 18+ client for `getContractCapabilities()`, owner-scoped `listHooks()`, and `registerHook()`. It requires an explicit bearer access token, accepts only HTTPS callback URLs in its registration helper, surfaces non-2xx responses as structured `PayTrayApiError` instances, and exposes no payment, ledger, settlement, or AI-promotion mutation methods. Consumers can retrieve the OpenAPI document directly from `/api/v2/extensions/openapi.json` or use the generated TypeScript declarations at `packages/sdk/src/index.d.ts`.

## `GET /api/v2/extensions/contracts`

Returns the versioned BD public extension contract for an `extensions:*` token. The v2 contract enumerates supported event names, allowed projections (`identifiers`, `lifecycle`, `provenance`, `timestamps`, and `metrics`), bounded replay windows, signed/retryable delivery, dead-letter observability, forbidden raw-content keys, and `settlementAuthority: false`.

## `POST /api/v2/extensions/hooks`

Registers a v2 extension hook only for an allowlisted event and bounded projection set. Callback URLs retain SSRF-safe validation and delivery-time DNS revalidation. The extension payload is a versioned envelope containing safe identifiers, lifecycle fields, provenance, timestamps, and numeric metrics as selected by the hook; forbidden fields are dropped before delivery. Public extensions never establish payment or settlement state.

## `GET /api/v2/extensions/hooks`

Lists only the authenticated owner’s v2 hooks and their contract metadata. Legacy `/api/extensions/hooks` remains available separately for backward compatibility and is not treated as the v2 public schema.

## `backend:ready:postgres:check`

The AW verifier requires `READY_POSTGRES_DATABASE_ISOLATED=true` before it initializes PostgreSQL. With an explicitly isolated target, it runs migrations, creates a disposable engagement fixture, reads the public extension OpenAPI document, exercises the BG payment-state route, registers v2 extension contracts, reads audit/lineage/outbox/inbox/verifier evidence, and calls the BH outbox processor in dry-run mode. The BG check requires `payment_status: not_requested`, `paymentStateMayBeStale: false`, `mutation: read_only`, and `settlementAuthority: false`; the BH check requires `dryRun: true`, `claimed: 0`, `mutation: read_only`, and no settlement mutation. It accepts a `503` verifier response when the cursor is not configured, but requires the response to remain structured, read-only, and non-authoritative. The disposable CI run returned `status: verified`; without the isolation flag it exits `1` before database access. BF’s reviewer write path remains intentionally excluded because the verifier must not fabricate a human reviewer decision.

## `GET /api/v2/ops/outbox/health`

Returns durable `outbox_events` delivery health and is protected by `ops:*`. The response is `200` with `status: ok` when no dead-letter events exist, or `503` with `status: attention` when the dead count is nonzero. It is read-only and never changes payment, ledger, or settlement state.

```json
{
  "success": false,
  "health": {
    "status": "attention",
    "total": 12,
    "processed": 8,
    "pending": 1,
    "leased": 1,
    "failed": 1,
    "dead": 1,
    "due": 2,
    "deliverySuccessRate": 0.666667,
    "retryableCount": 3,
    "authority": "durable_outbox_delivery_health",
    "mutation": "read_only",
    "deploymentPerformed": false,
    "settlementMutationPerformed": false
  }
}
```

## `GET /api/v2/ops/outbox/events`

Returns bounded, paginated, filterable outbox evidence. Supported status filters are `processed`, `pending`, `leased`, `failed`, and `dead`. Payload bodies are not returned; the response contains payload SHA-256 fingerprints and top-level payload keys to prevent sensitive event content from becoming an operator export.

The durable outbox is written in the same transaction as verifier-owned financial audit projection for API-ingested and worker-ingested chain events and human shadow-review audit evidence. Delivery failure is retryable with bounded backoff; reaching the configured attempt limit classifies an event as dead-letter attention. A delivery attempt cannot establish settlement.

## `GET /api/v2/ops/verifier/operations`

Returns the same composed verifier-operations evidence as the CLI, protected by `ops:*`. It responds `200` only when the verifier is fresh, reconciliation is clean, and all chain evidence is linked. It responds `503` with a structured blocked evidence object for stale, missing, not-configured, or reconciliation-attention states.

## `backend:verifier:operations:check`

The AV command composes verifier observability, durable reconciliation, and verifier/ledger-worker audit activity. It reports `status: ready` only when the cursor is fresh, reconciliation is `ok`, and no chain evidence is unlinked. It exits `1` for stale, missing, not-configured, or attention states.

```json
{
  "status": "blocked",
  "reason": "verifier status is not_configured; reconciliation status is ok",
  "authority": "verifier_operations_evidence",
  "mutation": "read_only",
  "deploymentPerformed": false,
  "settlementMutationPerformed": false
}
```

## `GET /api/v2/intelligence/advisory/capabilities`

Returns the BA advisory-AI boundary configuration for an `intelligence:*` token. It reports provider/model configuration, maximum latency, maximum cost, retrieval cap, retention period, raw-content policy, human-review requirement, and authority flags. It never returns a prompt, message, transcript, raw retrieval content, or secret.

## `POST /api/v2/intelligence/advisory`

Accepts only structured, content-free subject features, bounded retrieval references, and explicit source event IDs. The provider adapter must implement `complete(input)` and return `{ output, costMicrounits }`. The route returns `503` when AI is disabled, the provider/model is not configured, the provider times out, or its cost exceeds the configured budget. Input boundary violations return `400`.

Every successful result has `promotionStatus: shadow_only`, `humanOverrideRequired: true`, `applied: false`, `settlementAuthority: false`, `rawContentPersisted: false`, and `mutation: read_only`. The result is advisory evidence and cannot change ranking, payment state, ledger state, reputation, dispute state, or settlement.

## `backend:advisory:ai:check`

The BA capability check exits `0` only when advisory AI is enabled, a provider and model are configured, and raw-content persistence is disabled. The safe default is `blocked` because no provider is configured in development.

## `backend:token:metadata:check`

The AX command performs read-only RPC calls to the configured ERC-20 token contracts. It compares the provider chain ID, token symbol, and token decimals with the PayTray registry. It does not submit a transaction, approve an allowance, or mutate a contract.

A successful result reports `status: matched`. A chain mismatch, symbol mismatch, decimals mismatch, unreadable token, absent enabled token, or RPC error returns `status: blocked` and exit `1`.

## `backend:recovery:check`

The AU command requires:

```bash
DATABASE_URL='postgresql://...'
RECOVERY_BACKUP_FILE='/protected/evidence/paytray-<commit>.dump'
```

It creates a custom-format `pg_dump`, validates the `pg_restore --list` catalog, and exits `1` with `schema_catalog_only` when no restore target is supplied. A full restore requires:

```bash
RECOVERY_RESTORE_DATABASE_URL='postgresql://...isolated-database...'
RECOVERY_TARGET_ISOLATED=true
```

The restore target must differ from `DATABASE_URL`; otherwise the command fails closed. A successful isolated restore reports `status: verified` and exit `0`. The command reports `deploymentPerformed: false` and `settlementMutationPerformed: false` in all cases.

## Durable payment-intent contract

The product-facing time-to-money sequence remains:

1. `GET /api/v2/discovery/experts` records privacy-safe impressions.
2. `POST /api/v2/engagements` carries discovery context into a durable engagement.
3. `POST /api/v2/payment-intents` creates an exact-base-unit intent with idempotency protection.
4. `POST /api/v2/engagements/:engagementId/payment-intent` attaches the durable intent to the engagement.
5. A wallet submits a transaction separately; the API does not claim settlement.
6. `POST /api/v2/verifier/chain-events` or the bounded verifier worker accepts only verifier-owned protocol evidence.
7. Ledger reflection and reconciliation follow verified chain evidence.

The controlled smoke harness is `backend:smoke:phase2:check`. It refuses to run unless `SMOKE_DATABASE_ISOLATED=true`, Base Sepolia is selected, mainnet settlement is disabled, and an enabled registry token is available. It creates no chain transaction and emits `chainTransactionSubmitted: false`.

## References

[1]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/auditLogService.js Financial audit service

[2]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/discoveryLineageService.js Discovery lineage service

[3]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/scripts/verify-phase2-loop.mjs Controlled no-live-funds smoke harness

[4]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/payments/paymentApiService.js Durable payment-intent contract
[5]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/outboxDeliveryService.js Durable outbox delivery service
[6]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/advisoryAiBoundary.js Advisory-AI boundary
[7]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/collaborationHealth.js Collaboration health boundary
[8]: https://github.com/OxCryptobot/PAYTRAY/blob/cce1e882fd0db74252365a9df41e2bb93071a843/packages/backend/lib/extensionContracts.js Public extension contracts
[9]: https://github.com/OxCryptobot/PAYTRAY/blob/ef79f40d29b9d6c46124da13ebb7cb381b9fafb5/packages/backend/lib/shadowReviewService.js Durable shadow-review audit evidence
[10]: https://github.com/OxCryptobot/PAYTRAY/blob/124701ba78d79d96f2abd51ccd59580e9db86a49/packages/backend/lib/webhookSignature.js Webhook HMAC, timestamp, and replay verification
[11]: https://github.com/OxCryptobot/PAYTRAY/blob/210f2573025ef1fe7bbff2965fc63172ac3b68f6/docs/security/webhook-replay-store-integration.md Shared durable replay-store integration guidelines
