# PayTray Phase 3 Weeks 5–6 Production Telemetry Contract

**Purpose:** Ingest production product-loop telemetry for quality measurement and shadow evaluation without granting AI authority over ranking, payments, ledgers, withdrawals, disputes, or reputation.

## Event envelope

Every telemetry event must contain `eventId`, `eventType`, `occurredAt`, `receivedAt`, `actorScope`, `entityType`, `entityId`, `correlationId`, `schemaVersion`, `source`, `privacyClass`, `payload`, and `provenance`. `eventId` is globally unique and is the idempotency key. `occurredAt` is the producer timestamp; `receivedAt` is server time used for ingestion lag.

## Allowed event types

| Event type | Product use | Truth authority |
|---|---|---|
| `discovery_impression` | Search coverage, rank position, baseline score | Product observation; no financial authority |
| `match_selected` | Discovery-to-engagement conversion | Authenticated user action |
| `engagement_created` | Match-to-chat funnel | Durable engagement record |
| `collaboration_state_changed` | Session resilience and completion funnel | Durable engagement state |
| `payment_intent_created` | Payment-intent conversion | Durable financial intent, not settlement |
| `payment_chain_event_verified` | Payment evidence and finality | Verifier/indexer evidence only |
| `ledger_entry_reflected` | Financial projection health | Immutable ledger journal |
| `outcome_verified` | Ranking/reputation label | Verified session/payment/dispute evidence |
| `shadow_evaluation_completed` | Model quality and data coverage | Evaluation run record |

## Redaction and privacy

Telemetry must reject raw message bodies, transcripts, call recordings, private keys, signatures, full payment payloads, and unrestricted wallet graphs. Sensitive values are represented by stable IDs or hashes. `privacyClass` is one of `operational`, `derived_non_content`, `sensitive_derived`, or `restricted`. Restricted events are not eligible for AI feature export.

## Idempotency and ordering

Duplicate `eventId` submissions return the existing event result and do not increment counters twice. Events may arrive out of order; consumers use `occurredAt`, source sequence, and durable entity state rather than arrival order. Financial events remain source-bound to verified chain or ledger evidence and cannot be synthesized by telemetry ingestion.

## Retention and access

Telemetry retention follows the source data’s policy. Financial and audit-linked events are retained under financial controls; derived non-content events may be aggregated or anonymized after the evaluation window. Access is operator-scoped and purpose-limited. Telemetry cannot be used to reconstruct private conversation content.

## Live-shadow limits

Live shadow evaluation may read eligible verified events, compute candidate outputs, persist metrics, and record unapplied decisions. It must not alter ranking responses, profiles, payment state, ledger entries, withdrawal availability, dispute state, reputation, or user-visible financial status. Promotion requires a reviewed evaluation run, model/version provenance, data-quality thresholds, subgroup review, cost/latency bounds, and an explicit rollback target.
