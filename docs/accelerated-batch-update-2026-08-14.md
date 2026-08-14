# PayTray Accelerated Batch Update

**Date:** 2026-08-14  
**Branch:** `paytray/batch-delivery`  
**Remote baseline:** `8498c8643e32691abb12aaa320862dd829e2e3a8`  
**Current state:** New batch changes are validated locally and remain uncommitted.

## Delivered in this update

| Batch | Delivered capability | Safety boundary |
|---|---|---|
| **Q — RPC-backed verifier execution** | Added `POST /api/v2/verifier/poll`, explicit `PAYMENT_RPC_URL` gating, configured Base Sepolia worker construction, durable cursor use, and configured-worker readiness status. | Polling cannot run unless an explicit HTTPS RPC URL is configured; the endpoint remains operator-scoped and `shadow_only`. |
| **R — Flow event hydration** | Updated the official Sablier Flow v3 decoder to hydrate token and participant metadata from durable streams for deposit, pause, refund, restart, void, and withdrawal events. BigInt payloads are JSON-safe. | Events without a verified durable stream context are ignored rather than assigned fabricated token or wallet evidence. |
| **S — lifecycle status UX** | Added client “Refresh verified status” behavior for engagement, payment-intent, and chain-finality state. | The client reports state but never claims settlement or mutates payment state. |
| **T — shadow evidence** | Added detailed operator shadow-run evidence at `GET /api/v2/ops/shadow-runs/:runId`, including decisions, counts, reviewer status, and rollback context. | The response explicitly remains `shadow_only` and `human_review_required`; applied decision count is surfaced for audit. |
| **V — chain safety defaults** | Made Base Sepolia (`84532`) the default settlement chain and added explicit production-only `PAYMENT_MAINNET_ENABLED=true` gating paired strictly with Base mainnet chain ID `8453`. Updated API fixtures and configuration tests. | Local development and testnet operation cannot silently default to Base mainnet or accept an inconsistent mainnet flag. |

## Validation

The latest run passed **24 test files and 134 tests**, client JavaScript syntax validation, ESLint, PostgreSQL migration validation through migration 013, and `git diff --check`. The tightened configuration test also confirms Base Sepolia defaults and rejects unsafe mainnet flag/chain combinations.

## Commit and push boundary

These new files are modified locally but have **not** been committed or pushed:

- `packages/backend/lib/payments/sablierFlowV3.js`
- `packages/backend/lib/payments/verifierWorkerService.js`
- `packages/backend/lib/shadowReviewService.js`
- `packages/backend/server.js`
- `packages/backend/tests/sablierFlowV3.test.js`
- `packages/backend/tests/shadowReviewService.test.js`
- `packages/client/app.js`
- `packages/client/index.html`
- `packages/backend/lib/config.js`
- `packages/backend/tests/config.test.js`
- `packages/backend/tests/api.test.js`
- `docs/engineering-audit-time-to-money-2026-08-14.md`
- this document

No deployment, mainnet transaction, live funds, or real user data was used. The existing remote branch remains unchanged at the previously pushed commit until explicit approval is provided for the next commit and push.
