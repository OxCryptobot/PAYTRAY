# Paytray Financial-Core Tranche: Completion Record

**Date:** 2026-08-14  
**Scope:** Phase 0 through the first implementation tranche of the approved best-in-class plan  
**Status:** Implemented foundation; no production payment activation

## Delivered outcomes

This tranche converts Paytray’s payment roadmap from a simulated stream concept into an explicit architecture for a verified, durable time-to-money core. It does not connect to a live wallet, RPC provider, or streaming protocol, and it does not move funds.

| Area | Delivered artifact | Why it matters |
|---|---|---|
| Protocol decision | `docs/adr/0001-initial-streaming-protocol.md` | Selects Sablier Flow v3 on Base Sepolia for testnet adapter development, subject to documented production gates. |
| Lifecycle authority | `docs/payments/payment-stream-lifecycle.md` and `paymentLifecycle.js` | Separates intent, wallet submission, chain inclusion, finality, and ledger reflection. |
| Token correctness | `tokenRegistry.js` | Requires chain ID, token contract address, decimals, enablement, and optional protocol contract rather than a free-form token symbol. |
| Verified event boundary | `protocolAdapter.js` and `verifierService.js` | Validates event identity and permits only the verifier to advance a stream to chain finality. |
| Durability | `002_financial_core.sql`, `migrations.js`, `financialRepository.js` | Defines migrations and parameterized persistence contracts for intents, streams, events, ledger entries, idempotency, outbox, and audit records. |
| Compatibility | `docs/api/phase1-compatibility-inventory.md` | Preserves current clients while planning a command/event-oriented payment API v2. |
| Threat controls | `docs/payments/threat-model.md` | Captures wallet, token, finality, reorg, withdrawal, SSRF, operational, and AI data-risk controls. |
| Legacy safety | `config.js`, `server.js` | Confines participant-written confirmation simulation to non-production and labels it as unverified. |

## Validation evidence

| Check | Result |
|---|---|
| Backend tests | Passed: **4 test files, 73 tests** |
| Linting | Passed: ESLint clean |
| Diff validation | Passed: `git diff --check` clean |
| New focused coverage | Token registry, lifecycle ownership, protocol event normalization, verifier finality, reorg rejection, migration ordering, legacy migration compatibility, parameterized payment intent persistence, idempotent chain-event replay, and ledger-source requirements. |

## Explicit non-claims

1. Paytray is **not** connected to Sablier Flow, Base Sepolia, Base mainnet, an RPC provider, or a chain indexer in this tranche.
2. The current legacy payment-stream route remains a development simulation and is explicitly labeled `source: legacy_development_simulation` and `finalityStatus: unverified`.
3. The new migration has been validated structurally and through the migration-runner test, but it has not been run against a configured PostgreSQL instance in this workspace.
4. The financial repository is an extracted, parameterized interface; the monolithic server has not yet been migrated to call it for live endpoint requests.

## Next implementation gates

1. Configure a disposable PostgreSQL integration environment and execute the migration path from `001_init` through `002_financial_core`.
2. Install and integrate the selected protocol SDK against Base Sepolia, using an explicit non-production token registry.
3. Build a verifier worker that records idempotent chain events, applies confirmation depth, and invokes `applyVerifiedProtocolEvent` plus the ledger worker.
4. Introduce `/api/v2/payment-intents` and `/api/v2/streams` with exact base-unit/token-address contracts while retaining v1 compatibility only for development migration.
5. Complete testnet lifecycle tests for create, top-up, pause, restart, void, withdrawal, replay, and reorg handling before any production activation review.

## Approval required before production payment work

Production activation requires the configured chain/RPC/indexer, approved token allowlist, contract/version verification, finality/reorg policy, security review, monitoring/runbooks, and an explicit remote-deployment decision. No such action has been attempted here.
