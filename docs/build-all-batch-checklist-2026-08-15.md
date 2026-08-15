# PayTray Build-All Batch Checklist

**Project:** PayTray — AI-enabled time-to-money platform connecting expert discovery, real-time collaboration, and ERC-20 payment streams.

**Branch:** `paytray/batch-delivery`

**Safety boundary:** Base Sepolia (`84532`) remains the safe settlement default. Verifier-owned chain evidence and the durable ledger establish economic truth. AI outputs remain advisory and `shadow_only`. This checklist does not authorize deployment, mainnet transactions, live-fund movement, real-user-data migration, fabricated reviewer decisions, fabricated approval tokens, or fabricated signing keys.

## Batch execution status

| Batch | Scope | State | Exit evidence |
|---|---|---|---|
| BS | Production Base Sepolia verifier-worker entrypoint and configuration contract | Pushed | `6e857f2`; explicit worker opt-in, HTTPS RPC, token/protocol consistency, transactional bounded polling, durable cursor projection, graceful shutdown, and read-only configuration verification. |
| BT | Reproducible CI and local quality gate | Pushed | `6e857f2`; shared `backend:quality:check`, locked dependency installation, Node 22 workflow, full tests, lint, extension contract, migration, and isolated PostgreSQL route checks. |
| BU | Unified target-operations readiness integration | Pushed | `6e857f2`; target preflight includes verifier-worker readiness and remains `releaseEligible: false` until real target evidence is present. |
| BV | Security and performance hardening | Pushed | `6e857f2`; bounded rate-limit state, explicit proxy trust, bounded JSON/urlencoded bodies, and regression coverage for memory and IP-source behavior. |
| BW | API/SDK and developer-experience optimization | Pushed | `a8c90bb`; read-only SDK/OpenAPI runtime/type drift verifier, documented SDK paths, operation IDs, safety metadata, registration defaults, and TypeScript declarations. |
| BX | Release-evidence automation | Pushed | `a8c90bb`; read-only evidence bundle and CLI aggregate target, verifier, reconciliation, delivery, shadow-review, rollback, sign-off, and signing-key blockers; always `releaseEligible: false`. |
| BZ | Composite runtime health and API SLOs | Implemented locally | Authenticated operator endpoint with bounded availability/latency samples, dependency health, named blockers, and immutable payment/release authority metadata. |
| CA | Ready-PostgreSQL runtime-health contract | Pushed | `35550cc`; isolated verifier confirms runtime-health route safety and accepts expected `503` while verifier freshness is absent; overall `status: verified`. |
| CB | Canonical hashed reconciliation evidence | Pushed | `918d115`; deterministic SHA-256 evidence hash, current Git boundary, issue count, and immutable read-only metadata; local disposable report returned `status: verified` with zero issues. |
| CC | Centralized release/reconciliation evidence collectors | Pushed | `661af74`; shared database-backed collectors keep the CLI and authenticated operator APIs on one evidence contract. |
| CD | Authenticated operator evidence APIs | Pushed | `661af74`; release and reconciliation evidence endpoints pass ready-PostgreSQL safety checks and preserve structured `503` responses when evidence is incomplete. |
| CE | Immutable evidence fingerprint utility | Validated locally | Canonical SHA-256 fingerprints for release, reconciliation, and unified operator evidence; no secrets or signing-key material included. |
| CF | Unified operator evidence surface | Pushed | `42fb774`; `/api/v2/ops/evidence` combines release and reconciliation evidence, returns expected `503` while target/verifier/reviewer gates are incomplete, and remains read-only. |
| CG | Operations-quality matrix | Validated locally | `backend:operations:quality:check` runs existing read-only checks, classifies missing operator evidence as `operator_blocked` in normal mode, and supports strict release-environment failure semantics. |
| BY | Multi-chain expansion | Deferred | Do not begin until single-chain reliability, reconciliation SLOs, rollback, and target verifier evidence are proven. |

## Buildable engineering work

| Priority | Work item | Planned validation |
|---:|---|---|
| P0 | Run the verifier as an explicit production process rather than leaving the chain authority only as a library contract. | Configuration verifier, worker-service tests, transactional polling contract, Base Sepolia fail-closed checks, and target preflight integration. |
| P0 | Keep CI aligned with the local quality boundary. | GitHub Actions on pushes and pull requests, Node 22, locked install, full test/lint/contract checks, Postgres 16 service, migration and ready-route verification. |
| P1 | Bound all recurring work and make operational opt-ins explicit. | Worker and housekeeping configuration checks, bounded polling intervals/ranges, graceful shutdown, no implicit background process. |
| P1 | Preserve economic and AI authority boundaries while optimizing delivery. | No worker or CI path can establish settlement from intent, promote AI ranking, approve shadow runs, or mutate release evidence. |
| P1 | Consolidate release and operator checks. | Read-only aggregate reports, redacted target settings, explicit named blockers, and `releaseEligible: false` until genuine evidence exists. |

## Operator-only release gates

These gates cannot be completed by code changes alone and must remain pending until real evidence is supplied by authorized operators and reviewers.

| Gate | Required evidence | Current state |
|---|---|---|
| Railway target | Authenticated redacted settings match Base Sepolia, protocol, token, database, RPC, webhook, verifier, and scope policy. | Pending. |
| Database recovery | Protected backup fingerprint and isolated restore verification in the target environment. | Pending beyond disposable local restore evidence. |
| Verifier freshness | Real HTTPS RPC, worker startup, durable cursor persistence, finality, replay/reorg evidence, and chain-event audit. | Pending; checked environments remain unconfigured or not fresh. |
| Reconciliation | Fresh-cursor reconciliation with no unresolved projection, ledger-linkage, or finalized-without-ledger issues. | Pending target evidence. |
| Shadow reviews | Genuine reviewer decisions for all six pending runs with evidence-backed notes and identity. | Pending; no automatic approvals. |
| Human sign-offs | Release operator, protocol/finance, AI/data, and security approvals for the same immutable artifact. | Pending. |
| Signing key | Approved secret-manager injection of the real Ed25519 private key and detached verification. | Not provided; never fabricate. |

## Latest validation evidence

The BS–BU/BW/BX/BZ/CA/CB/CC/CD/CE/CF/CG tranche passed **63 test files and 261 tests**, ESLint, the shared quality gate, migration validation through migration 017, the runtime-to-OpenAPI contract verifier, the verifier-worker configuration verifier with explicit Base Sepolia settings, a default target-preflight blocked result, a fully configured target-preflight result with `releaseEligible: false`, isolated ready-PostgreSQL verification with `status: verified`, and `git diff --check`. No worker was started against a live RPC, no deployment was performed, and no settlement mutation occurred.

## Standard execution order

1. Implement one or more code batches behind explicit authority and failure-mode contracts.
2. Run focused tests for the changed domain.
3. Run `npm run backend:quality:check`.
4. Run migration, extension, verifier-worker, target-operations, and ready-PostgreSQL checks appropriate to the batch.
5. Update this checklist and the canonical remaining-build checklist with exact evidence.
6. Commit and push only validated code and documentation.
7. Re-run the release-gate inspection without treating a blocked result as a defect to bypass.

## References

[1]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/MasterBlueprint.md MasterBlueprint roadmap and architecture

[2]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/docs/remaining-build-and-release-checklist.md Canonical remaining-build and release checklist
