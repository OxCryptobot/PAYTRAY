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
| **W — webhook SSRF safety** | Added reusable callback URL validation and DNS-resolution checks that reject loopback, private, link-local, metadata, credential-bearing, unsupported-protocol, and non-standard-port destinations. Hook registration now validates before queuing deliveries. | Extension hooks cannot target internal network addresses through the registration path; delivery remains operator-scoped and signed. |
| **X — retry safety** | Added delivery-time DNS revalidation, exponential retry scheduling, `nextAttemptAt` metadata, and configurable `WEBHOOK_RETRY_BASE_DELAY_MS`. | DNS rebinding is rechecked at delivery; failed deliveries cannot be retried continuously without backoff. |
| **Y — state recovery** | Added versioned snapshot validation, malformed-snapshot quarantine, restrictive `0600` persistence, atomic temporary-file writes, and recovery tests. | Corrupt or unsupported operational snapshots are quarantined rather than silently restored; payment truth remains in PostgreSQL/verifier evidence. |
| **Z — financial and verifier observability** | Added operator-scoped read-only `GET /api/v2/ops/financial/summary` for payment-intent status, durable-stream lifecycle, chain-event finality, ledger count, and unreconciled streams; added `GET /api/v2/ops/verifier/status` for cursor position, cursor age, RPC configuration, and confirmation threshold. | Both reports are explicitly `verifier_owned` and `read_only`; they cannot mutate payment or ledger state. |
| **AA — lifecycle authority hardening** | Removed `mock_adapter` from the canonical payment lifecycle event-source registry and every financial transition. Added regression coverage that rejects mock settlement authority while preserving verifier and ledger-worker transitions. | Test or simulation code cannot authorize economic state transitions through the production lifecycle contract; only explicit wallet, API, verifier, ledger-worker, and operations authorities remain. |

## Validation

The latest run passed **28 test files and 143 tests**, client JavaScript syntax validation, ESLint, PostgreSQL migration validation through migration 013, and `git diff --check`. The configuration, webhook, state-recovery, verifier-observability, and payment-authority tests confirm safe chain defaults, SSRF-safe delivery, quarantine recovery, read-only finality visibility, and rejection of mock settlement authority.

## Commit and push boundary

These new files are modified locally but have **not** been committed or pushed:

- `packages/backend/lib/payments/paymentLifecycle.js`
- `packages/backend/tests/paymentAuthority.test.js`
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
- `packages/backend/lib/webhookSecurity.js`
- `packages/backend/tests/webhookSecurity.test.js`
- `packages/backend/lib/stateStore.js`
- `packages/backend/tests/stateStore.test.js`
- `packages/backend/lib/verifierObservability.js`
- `packages/backend/tests/verifierObservability.test.js`
- `docs/engineering-audit-time-to-money-2026-08-14.md`
- this document

No deployment, mainnet transaction, live funds, or real user data was used. The W–Z tranche is pushed at commit `3a44dbf0034945f84e5c0e8b885e3cd88a32db5b`; Batch AA is the next local uncommitted tranche awaiting its own commit/push boundary.
