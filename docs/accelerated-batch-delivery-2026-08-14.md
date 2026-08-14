# PayTray Accelerated Batch Delivery

**Date:** 2026-08-14  
**Branch:** `paytray/batch-delivery`  
**Status:** Implemented and validated locally; all changes remain uncommitted; no remote push or deployment performed.

## Delivery objective

This delivery batch advances PayTray as an AI-enabled time-to-money platform for freelancers, clients, and experts. The implementation preserves the core product loop: discover an expert, carry context into an engagement, create and attach a time-based ERC-20 payment intent, accept only verifier-owned chain evidence as economic truth, record verified outcomes, and evaluate discovery improvements in shadow mode.

## Batches delivered

| Batch | Delivered capability | Product and safety impact |
|---|---|---|
| A | Production telemetry normalization, privacy rejection, idempotent ingestion, payload hashing, operator health, per-event-type median/p95 lag. | Operators can measure discovery/evaluation coverage without storing raw collaboration content or secrets. |
| B | Verifier-owned outcome transitions, immutable verification provenance, discovery-impression-to-engagement lineage, verified evaluation labels. | Participant reports remain unverified until an authorized verifier records structured evidence. |
| C | Ledger-entry replay protection, chain-event crash-recovery reprojection, durable verifier chain-event processing, audit records, intent-backed stream provisioning. | Retries cannot silently duplicate accounting entries, and persisted chain evidence can recover a lifecycle projection after a worker crash. |
| D | Client engagement-linked payment intent flow, stable idempotency key, automatic intent attachment, explicit unverified finality messaging. | The client surface now separates conversation readiness, payment intent creation, attachment, wallet submission, and settlement finality. |
| E | Operator release-readiness evaluator and explicit human shadow-run review endpoint. | A candidate can never become applied merely because an evaluation run exists; human review, rollback, and promotion gates remain explicit. |

## New protected endpoints

| Endpoint | Scope | Authority |
|---|---|---|
| `POST /api/v2/verifier/chain-events` | `ops:*` | Accepts protocol-adapter-validated chain evidence and projects payment lifecycle state. |
| `POST /api/v2/outcomes/:outcomeId/verify` | `ops:*` | Transitions participant-reported outcomes from `unverified` to `verified` or `rejected`. |
| `POST /api/v2/ops/shadow-runs/:runId/review` | `ops:*` | Records explicit human review without applying the candidate. |
| `GET /api/v2/ops/release-readiness` | `ops:*` | Reports shadow-pilot readiness and permanent promotion blockers. |
| `POST /api/v2/telemetry/events` | `ops:*` | Ingests privacy-safe operational telemetry with replay handling. |
| `GET /api/v2/telemetry/health` | `ops:*` | Reports telemetry quality and shadow-review health. |

## Validation evidence

The final validated state reports:

- **20 test files passing and 121 tests passing.**
- ESLint passing.
- `git diff --check` passing.
- PostgreSQL migration validation passing through migration 012.
- Migrations 009–012 confirmed: verified outcome provenance, intent ledger idempotency, payment-stream verifier provenance, and shadow-run review metadata.
- Base Sepolia CI loop passing from discovery through engagement, payment intent, verifier-owned stream provisioning, `chain_included` lifecycle projection, participant outcome capture, and replay-safe outcome submission.
- Read-only CI release-readiness inspection passing and correctly reporting `promotionStatus: shadow_only`.

The end-to-end verifier pilot used only configured CI/testnet data. It did not submit a live wallet transaction, use mainnet, use real funds, or use real user data.

## Current release decision

The platform is **not ready for candidate ranking promotion**. The CI inspection reported protocol and token readiness, verified outcomes present, healthy telemetry, and no restricted telemetry events. It still reported pending shadow reviews and `promotionAuthority.ready: false`, which is intentional. The promotion boundary remains human-controlled and rollback-targeted to the Phase 2 baseline.

> PayTray’s chain verifier establishes economic truth; an API request, participant report, telemetry event, or AI decision cannot settle funds or mutate the authoritative ledger by itself.

## Key implementation files

The primary files for this delivery are `packages/backend/lib/payments/verifiedEventService.js`, `packages/backend/lib/payments/chainEventProcessor.js`, `packages/backend/lib/payments/financialRepository.js`, `packages/backend/lib/outcomeService.js`, `packages/backend/lib/releaseReadiness.js`, `packages/backend/lib/shadowReviewService.js`, `packages/backend/lib/telemetryObservability.js`, `packages/backend/lib/engagementService.js`, `packages/backend/server.js`, and `packages/client/app.js`.

The schema additions are migrations `009_verified_outcome_provenance.sql` through `012_shadow_run_review.sql`. Supporting tests cover verifier outcomes, chain-event recovery, intent-backed stream provisioning, ledger replay safety, telemetry quality, release readiness, and shadow-run review.

## Next batch

The next accelerated batch should focus on a real verifier worker lifecycle around the configured Sablier Flow v3/Base Sepolia adapter, including bounded polling, cursor durability, reorg handling, reconciliation reports against the ledger, and operator review of pending shadow runs. The candidate ranker must remain shadow-only until the explicit gates in `docs/phase3-evaluation-export-contract.md` are satisfied.
