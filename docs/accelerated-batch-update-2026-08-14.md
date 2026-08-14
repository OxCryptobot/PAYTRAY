# PayTray Accelerated Batch Update

**Date:** 2026-08-14  
**Branch:** `paytray/batch-delivery`  
**Remote baseline:** `8498c8643e32691abb12aaa320862dd829e2e3a8`  
**Current state:** Batch AF is validated locally and remains uncommitted.

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
| **AB — legacy mutation quarantine** | Added a reusable production guard to all legacy in-memory payment mutation routes: stream creation, confirmation, withdrawal, cancellation, and dispute mutation/resolution. Durable v2 APIs remain the production path. | Production cannot mutate financial state through the legacy in-memory route family; non-production tests retain compatibility and the denial is explicit and auditable. |
| **AC — durable summary correctness** | Corrected financial observability to group streams by durable `lifecycle_state` and scope payment-intent counts to the configured settlement chain. Updated regression coverage for the operator summary. | Operator metrics no longer report legacy stream status as durable lifecycle truth or mix payment-intent counts across unsupported chains. |
| **AD — verifier freshness gate** | Added bounded `VERIFIER_CURSOR_MAX_AGE_MS` configuration and evidence-based release-readiness gating from the durable verifier cursor. Production readiness now distinguishes fresh, stale, and missing cursors; non-production remains usable without a configured worker. | RPC configuration alone cannot make production shadow-pilot readiness pass; the verifier must have recent durable cursor evidence. |
| **AE — operator verifier status classification** | Extended `GET /api/v2/ops/verifier/status` with explicit `fresh`, `stale`, `missing`, and `not_configured` classifications, readiness boolean, freshness threshold, and an operator-readable reason. | The status remains read-only and verifier-owned; operator dashboards cannot mistake an unconfigured or stale cursor for healthy chain verification. |
| **AF — deployment preflight** | Added `backend:deployment:check`, a read-only configuration preflight that validates production database/JWT/RPC/protocol/webhook/token/mainnet-gate requirements and identifies the deployment target. | The preflight performs no deployment, network call, transaction, or state mutation; it is suitable for Railway trial validation before any explicit deployment approval. |

## Validation

The latest run passed **31 test files and 151 tests**, client JavaScript syntax validation, backend/client artifact existence checks, the read-only deployment preflight, ESLint, PostgreSQL migration validation through migration 013, and `git diff --check`. The focused deployment-preflight tests cover complete production configuration and unsafe RPC/token-registry rejection.

## Railway development-server trial context

The user identified the following Railway project as a development-server trial for testing or possible deployment: [Railway project](https://railway.com/project/013770d1-6f03-48ae-a346-cc7dcce1629b?). This is recorded as **deployment context only**. No Railway login, deployment, environment mutation, production rollout, mainnet transaction, live fund movement, or real-user-data operation was performed during this batch.

Before any Railway deployment, the project still requires explicit deployment approval, production environment review, HTTPS RPC configuration, token-registry verification, database migration execution, verifier-cursor freshness validation, smoke tests, and confirmation that settlement remains Base Sepolia unless the separately gated mainnet policy is deliberately approved.

## Remaining batch path

| Planned batch | Priority scope | Exit condition |
|---|---|---|
| **AG — Railway trial smoke gate** | Run the preflight and authenticated/read-only smoke checks against the user’s development environment only after explicit deployment approval. | Railway trial is verified without production settlement, live funds, or unreviewed environment mutation. |
| **AH — reconciliation SLOs and alert evidence** | Add bounded discrepancy age, verifier lag, ledger projection lag, and operator alert evidence to the read-only reconciliation surface. | Operators can distinguish fresh, delayed, and attention-required financial projections. |
| **AI — AI ranking quality gate** | Extend shadow evaluation with rollback-target checks, segment coverage, confidence intervals, and explicit human promotion evidence while keeping promotion `shadow_only`. | No candidate ranking is promoted without review, rollback, and measurable baseline improvement. |
| **AJ — collaboration intelligence guardrails** | Add provenance, retention, cost, latency, and human override contracts for meeting guidance and summaries. | AI assistance remains advisory, attributable, bounded, and independent from settlement authority. |
| **AK — protocol reversal and withdrawal coverage** | Expand Base Sepolia Flow v3 evidence coverage for reorgs, reversals, pause/restart, withdrawals, and dispute-linked accounting checks. | Protocol lifecycle and reconciliation behavior are verified under adverse chain events. |
| **AL — release approval gate** | Combine deployment, database, verifier, reconciliation, shadow-review, rollback, and mainnet-policy checks into a final operator approval artifact. | Explicit human sign-off exists before any production deployment or mainnet settlement change. |

## Commit and push boundary

Only the following Batch AF files are modified locally and have not been committed or pushed:

- `package.json`
- `packages/backend/lib/deploymentPreflight.js`
- `packages/backend/scripts/verify-deployment-preflight.mjs`
- `packages/backend/tests/deploymentPreflight.test.js`
- `docs/accelerated-batch-update-2026-08-14.md`

No deployment, mainnet transaction, live funds, or real user data was used. The W–Z tranche is pushed at commit `3a44dbf0034945f84e5c0e8b885e3cd88a32db5b`, Batch AA is pushed at `b513aabe4a4043210dc9278d83c3c5b7be836735`, Batch AB is pushed at `787c77ef39c2a704cc51a831e83e6abebde22c6c`, Batch AC is pushed at `23194e876656d8b3b05be24774498d3cc635eee2`, Batch AD is pushed at `f42feecb38ff2f8b3761648f7a3ca38648af8595`, Batch AE is pushed at `64a6094822e6770355f7ea157b9ad84411df883f`, and Batch AF is the current local uncommitted tranche.
