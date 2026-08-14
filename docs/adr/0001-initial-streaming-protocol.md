# ADR 0001: Initial ERC-20 Time-Streaming Protocol

**Status:** Accepted for testnet adapter development; production activation remains gated  
**Date:** 2026-08-14

## Context

Paytray needs a streaming primitive that lets a client fund a provider’s time continuously, supports open-ended work, enables a sender to pause or stop funding, and lets the provider withdraw tokens that have become available. The Phase 1 repository currently models these concepts locally; it does not perform protocol transactions or verify chain events.

The initial product deliberately supports one chain and a small allowlist of ERC-20 assets. Paytray’s database and user interface must represent protocol evidence rather than treating client-submitted API state as payment finality.

## Decision

Use **Sablier Flow v3** as the initial *testnet* protocol candidate through an isolated Paytray adapter. Use **Base Sepolia** for the adapter spike and non-production integration environment. Base mainnet remains the intended production-chain candidate only after the production safety gates below are met.

Sablier Flow fits Paytray’s initial freelancer-client use case because it models an open-ended stream with a rate per second, permits top-ups, lets the sender pause and restart a stream, allows either party to void it, and allows recipient-directed withdrawals. The current maintained Flow implementation and official deployment documentation list Sablier Flow v3 deployments for both Base and Base Sepolia. [1] [2]

The testnet adapter must target the Flow v3 Base Sepolia contract through configuration rather than hard-coding addresses in business logic. The published Base Sepolia Flow v3 address is `0xc1ba5a41936aaab0ff920446db556efe17fc1c5d`; it is recorded here solely as external deployment evidence and must be revalidated against official documentation before every environment activation. [2]

## Consequences

Paytray’s internal lifecycle must map protocol evidence into product states without pretending that its local state is settlement. It will represent stream intent, wallet submission, chain inclusion, configured finality, and ledger reflection separately. The client wallet signs protocol calls; Paytray does not custody user private keys.

The first adapter will support a narrow token allowlist. Token metadata includes chain ID, ERC-20 contract address, decimals, display symbol, protocol contract, and enablement status. The system will use base-unit integer strings for authoritative values; JavaScript `Number` values are prohibited for protocol and ledger amounts.

This decision does not claim that Sablier Flow is the final production protocol. It establishes a tested adapter seam and validates whether Flow’s debt, pause, void, funding, and withdrawal semantics match Paytray’s engagement experience.

## Rejected alternatives

| Alternative | Reason not selected for the initial spike |
|---|---|
| Fixed-duration lockup streams | Less aligned with flexible, open-ended hourly or ongoing provider engagement. |
| Superfluid | A credible alternative, but it introduces its own token model and flow semantics; it remains a future comparison candidate if Flow’s insolvency or void semantics do not fit product requirements. |
| Custom Paytray streaming contract | Adds unnecessary protocol, audit, and operational surface before validating the product loop against a maintained deployment. |
| Multi-chain launch | Dilutes the ability to prove finality, reconciliation, support, and user experience on a single chain. |

## Production activation gates

1. Confirm Flow v3 contract/version, security review status, licensing implications, and deployment addresses from primary sources.
2. Complete a Base Sepolia end-to-end adapter test: create/update stream, pause, restart, void, top up, read availability, withdraw, and decode relevant events.
3. Define and test the exact user-facing consequences of sender insolvency, recipient void, partial funding, top-up, pause, and cancellation.
4. Deploy the verifier/indexer with idempotent event storage, configured confirmation depth, replay handling, and reorg recovery.
5. Approve a production ERC-20 allowlist, RPC/indexer provider, secret handling, monitoring, support runbook, and incident response.
6. Obtain a dedicated security review of Paytray’s protocol integration and financial-state projection before production enablement.

## References

[1]: https://github.com/sablier-labs/evm-monorepo/tree/main/flow
[2]: https://docs.sablier.com/guides/flow/deployments
[3]: https://docs.sablier.com/concepts/streaming
[4]: https://docs.superfluid.org/
