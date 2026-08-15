# PayTray v2 Operations and Lineage API Contracts

**Version:** `v2`

**Authority boundary:** All operations described here are read-only evidence or explicitly scoped verifier actions. API, AI, chat, and participant reports do not establish settlement. Only verifier-owned chain evidence and the durable ledger establish economic truth.

## Authentication and scope

Every `/api/v2/ops/*` route requires a valid PayTray access token with the `ops:*` scope. Ordinary wallet sessions and profile-only tokens must receive `403`. A valid operator token must receive an explicit database-service error when PostgreSQL is unavailable; the endpoint must not silently return an empty or fabricated report.

## `GET /api/v2/ops/audit/events`

Returns durable financial audit events from `financial_audit_events`. The route is paginated, filterable, and read-only. Sensitive metadata keys such as private keys, signatures, authorization headers, JWTs, passwords, and secrets are recursively redacted.

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

## `GET /api/v2/extensions/contracts`

Returns the versioned BD public extension contract for an `extensions:*` token. The v2 contract enumerates supported event names, allowed projections (`identifiers`, `lifecycle`, `provenance`, `timestamps`, and `metrics`), bounded replay windows, signed/retryable delivery, dead-letter observability, forbidden raw-content keys, and `settlementAuthority: false`.

## `POST /api/v2/extensions/hooks`

Registers a v2 extension hook only for an allowlisted event and bounded projection set. Callback URLs retain SSRF-safe validation and delivery-time DNS revalidation. The extension payload is a versioned envelope containing safe identifiers, lifecycle fields, provenance, timestamps, and numeric metrics as selected by the hook; forbidden fields are dropped before delivery. Public extensions never establish payment or settlement state.

## `GET /api/v2/extensions/hooks`

Lists only the authenticated owner’s v2 hooks and their contract metadata. Legacy `/api/extensions/hooks` remains available separately for backward compatibility and is not treated as the v2 public schema.

## `backend:ready:postgres:check`

The AW verifier requires `READY_POSTGRES_DATABASE_ISOLATED=true` before it initializes PostgreSQL. With an explicitly isolated target, it runs migrations and exercises authentication, collaboration health, v2 extension contracts and registration, audit events, discovery lineage, outbox health, and verifier operations. It accepts a `503` verifier response when the cursor is not configured, but requires the response to remain structured, read-only, and non-authoritative. The disposable CI run returned `status: verified`; without the isolation flag it exits `1` before database access.

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

The durable outbox is written in the same transaction as verifier-owned financial audit projection for API-ingested and worker-ingested chain events. Delivery failure is retryable with bounded backoff; reaching the configured attempt limit classifies an event as dead-letter attention. A delivery attempt cannot establish settlement.

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
