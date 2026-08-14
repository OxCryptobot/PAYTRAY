# PayTray Phase 2 MVP Coherence Loop

**Date:** 2026-08-14  
**Status:** Implemented and validated as a testnet-oriented MVP foundation; production payment activation remains gated

## Delivered

| Product capability | Implementation |
|---|---|
| Discovery v1 | `003_discovery_v1.sql` adds availability, timezone, languages, verification, response latency, completion, repeat-booking, paid-minute, and dispute fields. `discoveryService.js` applies structured filters and a deterministic weighted ranker with versioned explanations and evidence references. |
| Match-to-chat handoff | `004_engagement_context.sql` and `engagementService.js` persist the search brief, discovery context, ranking explanation, proposed time-stream terms, participant access, thread ID, collaboration status, and payment status as separate concerns. |
| Payment UX | The client now performs Base Sepolia chain checking, wallet challenge/signature login, and durable v2 payment-intent creation. It explicitly labels an intent as `unverified`; it does not submit or claim settlement. |
| Engagement client surface | `packages/client` supports expert filtering, fit review, conversation handoff, and testnet payment intent request without coupling collaboration to payment confirmation. |
| Outcome capture | `005_outcomes_and_metrics.sql` and `outcomeService.js` persist replay-safe participant outcome reports, keep them unverified, and compute durable pilot metrics. |
| Pilot metrics | `GET /api/v2/pilot/metrics` exposes durable engagement, conversation, payment-intent, completion, paid-time, dispute, and repeat-booking measures to operator-scoped callers. |

## API surface added

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v2/discovery/experts` | Structured expert discovery with explainable ranking. |
| POST | `/api/v2/engagements` | Create durable match-to-chat engagement context. |
| GET | `/api/v2/engagements/:engagementId` | Retrieve participant-authorized engagement context. |
| POST | `/api/v2/engagements/:engagementId/collaboration-state` | Record active/degraded/completed collaboration state. |
| POST | `/api/v2/engagements/:engagementId/payment-intent` | Attach a durable payment intent to the engagement. |
| POST | `/api/v2/engagements/:engagementId/outcomes` | Record participant-reported, unverified outcome evidence. |
| GET | `/api/v2/pilot/metrics` | Read operator-scoped pilot metrics. |

## Validation evidence

The Phase 2 end-to-end check passed against PostgreSQL for discovery, participant login, provider handoff, collaboration activation, payment-intent creation, intent attachment, outcome capture, and outcome replay. The full backend suite passes **10 test files and 90 tests**; linting, client JavaScript syntax validation, migration validation, and diff checks pass.

## Explicit remaining gates

The system still does not connect to a live Sablier Flow deployment or RPC/indexer, submit real transactions, reflect verified chain events into a ledger, or update reputation from verified outcomes. The client uses controlled Phase 1 discovery fixtures until a production discovery index and profile administration surface are completed. Participant outcome reports remain `unverified` by design. These are the next gates before a real-user testnet pilot.
