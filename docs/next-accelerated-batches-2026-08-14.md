# PayTray Next Accelerated Batches

**Date:** 2026-08-14  
**Branch:** `paytray/batch-delivery`  
**Status:** Validated locally and against the PostgreSQL CI database; all changes remain uncommitted.

## Delivery objective

This tranche advances PayTray as an AI-enabled **time-to-money platform** for freelancers, clients, and experts. It improves the path from durable discovery to verifier-owned payment evidence and operational review while preserving the non-negotiable boundary that API calls, participant reports, telemetry, and AI decisions cannot settle funds or mutate economic truth without authoritative chain verification.

## Delivered batches

| Batch | Implementation | Result |
|---|---|---|
| **L — verified Base Sepolia adapter** | Added an explicit Sablier Flow v3 provider/decoder factory using the official Flow v3 ABI and the documented Base Sepolia deployment address. Added opt-in `PAYMENT_RPC_URL` configuration and a configured database-worker constructor. | The worker can be connected to an explicit Base Sepolia HTTPS RPC without enabling network access by default. Unsupported Flow events are ignored until token metadata is hydrated from the durable stream, avoiding fabricated token evidence. |
| **M — finality and replay safety** | Added block-confirmation-based promotion to `finalized`, preserved bounded cursor polling, and prevented stale `included`/`observed` events from downgrading an already finalized stream. | Finality is derived from observed confirmations, and stale non-final events cannot silently rewrite a finalized lifecycle. |
| **N — operator review evidence** | Added a bounded `GET /api/v2/ops/shadow-runs` review queue with rollback target, metrics, model version, reviewer status, and human-review authority metadata. | Operators can inspect pending or terminal shadow-run evidence before making any decision; the endpoint has no candidate-application path. |
| **O — testnet-only pilot** | Re-ran the CI loop using Base Sepolia-compatible configuration and deterministic per-intent transaction/block evidence, followed by release-readiness and reconciliation inspections. | Discovery → engagement → payment intent → verifier-owned stream provisioning → `chain_included` projection → outcome capture → replay safety remained repeatable without live funds or mainnet activity. |

## Official protocol grounding

The decoder is based on the official Sablier Flow v3 deployment documentation and SDK ABI artifacts. The documentation identifies `0xc1ba5a41936aaab0ff920446db556efe17fc1c5d` as the SablierFlow v3.0 Base Sepolia deployment and identifies the v3.0 release as immutable and verified.[1] The official Flow repository describes Flow as an open-ended ERC-20 debt-tracking stream protocol with creation, top-up, pause, restart, void, refund, and withdrawal behavior.[2]

The decoder currently accepts the verified `CreateFlowStream` event because it contains the token address needed for PayTray’s token-registry validation. Later events are intentionally ignored by this first safe adapter until the worker hydrates the token from the already-created durable stream. This avoids fabricating token metadata or treating an incomplete event as economic evidence.

## Operator interfaces

| Endpoint | Authority and behavior |
|---|---|
| `GET /api/v2/ops/shadow-runs` | Operator-scoped, bounded read-only queue for pending, approved, or rejected shadow-run evidence. |
| `POST /api/v2/ops/shadow-runs/:runId/review` | Operator-scoped explicit human approval or rejection; never applies a candidate ranking. |
| `GET /api/v2/ops/reconciliation/durable` | Operator-scoped read-only stream, chain-event, ledger, and payment-intent evidence report. |
| `GET /api/v2/ops/release-readiness` | Operator-scoped readiness report; promotion remains permanently `shadow_only` until all human gates are satisfied. |
| `POST /api/v2/verifier/chain-events` | Operator-scoped verifier evidence ingestion and lifecycle projection. |

## Validation evidence

The latest validation completed with **23 test files and 131 passing tests**, ESLint passing, `git diff --check` passing, and PostgreSQL migration validation passing through migration 014. The Base Sepolia decoder has focused coverage for valid stream creation, contract filtering, unsupported event rejection, and explicit RPC configuration. The finality worker has coverage for confirmation-based finalization, bounded scanning, and durable cursor behavior. The chain-event processor has coverage for stale non-final event rejection after finality.

The CI release-readiness inspection continues to report healthy telemetry and verified outcome coverage, while ranking promotion remains blocked by pending shadow reviews and the permanently false promotion-authority gate. This is the correct safety state for the current testnet shadow pilot.

> Economic truth remains verifier-owned. Reconciliation reports surface discrepancies; they do not silently repair the ledger or payment lifecycle. AI ranking outputs remain advisory and shadow-only.

## Release gates

PayTray is **not ready for mainnet or ranking promotion**. Before any production-gated action, the project still requires explicit Base Sepolia RPC-backed worker execution against observed testnet logs, full Flow v3 event coverage with durable token hydration, reorg/reversal evidence, reconciliation approval, human review of pending shadow runs, rollback verification against the Phase 2 baseline, and an explicit deployment approval.

No remote push or deployment was performed. No live funds, production mainnet transaction, or real user data was used.

## References

[1]: https://docs.sablier.com/guides/flow/deployments "Sablier Flow v3 Deployment Addresses"

[2]: https://github.com/sablier-labs/flow "Sablier Flow Protocol Repository"
