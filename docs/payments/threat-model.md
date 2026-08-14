# Paytray Time-to-Money Threat Model

## Scope

This threat model covers wallet authentication, expert-client engagement, ERC-20 payment-stream intents, protocol events, off-chain ledger projections, chain verification, webhook delivery, operators, and AI-assisted product features.

## Assets to protect

| Asset | Required property |
|---|---|
| Client/provider wallet authority | Only the wallet holder can authorize a product action; Paytray never stores private keys. |
| Stream lifecycle truth | Product-visible status derives from verified protocol evidence and configured finality. |
| Provider withdrawal availability | Amounts, token decimals, recipient/beneficiary semantics, and withdrawal events are exact and auditable. |
| Ledger projections | Each finalized source event creates at most one immutable accounting effect. |
| Engagement privacy | Chat artifacts, profile data, and AI context are participant-scoped and minimized. |
| Operational controls | Operator actions are role-bound, logged, reviewable, and unable to fabricate chain evidence. |

## Primary threats and controls

| Threat | Example | Required control |
|---|---|---|
| Wallet/signature replay | A stale or reused message logs in a different session. | One-time, TTL-bound challenges stored durably; SIWE-style domain/chain binding; nonce consumption audit. |
| Refresh-token misuse | A long-lived refresh token is used as an API bearer token. | Enforce access-token type and issuer; add refresh rotation and revocation before refresh endpoints exist. |
| Role escalation | A client invokes reconciliation, ledger, or operator endpoints. | Explicit user/operator/admin roles, least privilege, audit logs, and approval workflow for sensitive operations. |
| Fake payment confirmation | A participant submits `reflected` without protocol evidence. | Verifier-only finalized/reflected transitions; transaction/event matching and finality policy. |
| Token substitution/decimal loss | A symbol or floating value maps to the wrong ERC-20 amount. | Chain/token allowlist, contract-address identity, decimals, base-unit strings, ABI-level validation. |
| Duplicate/reordered/reorg events | Provider event delivery creates duplicate credit or stale finality. | Unique `(chainId, txHash, logIndex)` events, finality depth, block-hash tracking, reorg rollback/reprojection, idempotent ledger constraints. |
| Incorrect withdrawal authority | A sender withdraws funds intended for a provider. | Recipient-directed product flow, protocol adapter validation, finalized withdrawal-event projection. |
| Stream insolvency or cancellation surprise | A client pauses/voids an underfunded stream and the provider sees misleading availability. | Explicit protocol semantics, real-time state labels, solvency/available amount display, support and dispute workflow. |
| Webhook SSRF | A hook invokes an internal endpoint or rebinding target. | Domain/IP allowlist, DNS and redirect checks, egress proxy, signed envelopes, quotas, audit logs. |
| RPC/indexer compromise or lag | A provider reports misleading or delayed chain data. | Multiple-source verification strategy, lag monitoring, block/finality evidence, degraded-state UX, replayable event log. |
| Secret leakage | RPC/API keys or webhook signing keys appear in logs or snapshots. | Secret manager, environment validation, redaction, rotation, least-privilege credentials. |
| AI data leakage or manipulation | A summary exposes another engagement, or feedback poisons ranking. | Participant-scoped retrieval, consent, PII minimization, verified outcome lineage, evaluation, human override, audit trail. |

## Security invariants

1. Paytray never signs or transfers a client/provider’s assets.
2. A wallet transaction hash is a submission reference, not proof of execution or finality.
3. A chain event is not product-final until the configured confirmation policy is met.
4. A ledger effect is generated only from a finalized, uniquely identified source event.
5. A user-visible amount is represented in exact token base units and accompanied by chain/token metadata.
6. Payment degradation does not revoke chat, artifact, or collaboration access unless an explicit product policy says otherwise.
7. Operator actions may initiate recovery workflows but cannot invent protocol events or directly mutate an immutable ledger.

## Verification scenarios

The test suite must simulate replayed wallet challenges, scope escalation, duplicate and reordered events, event replay after restart, reorg before finality, unsupported token/address, decimal edge cases, sender withdrawal attempt, recipient withdrawal confirmation, RPC outage, indexer lag, webhook SSRF attempts, and audit-log completeness.
