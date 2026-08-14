# Protocol Research Evidence: Initial Paytray Streaming Adapter

**Collected:** 2026-08-14  
**Purpose:** Document primary-source evidence for the Phase 0 choice to test Sablier Flow on Base Sepolia through an isolated Paytray adapter.

## Sablier streaming model

Sablier describes a stream as a digital agreement that releases ERC-20 assets over time. Its streaming documentation explains that token amounts can become withdrawable continuously, often every second, and frames a remote-worker payment stream as a way to limit a client’s exposure to the amount released before cancellation. [1]

## Sablier Flow semantics

The maintained Sablier Flow source describes open-ended ERC-20 streaming at a fixed rate per second, with no fixed end date. It lists top-ups, sender pause/restart, either-party void, refunds of unstreamed amounts, and recipient-directed withdrawal as protocol features. These characteristics match Paytray’s initial need for flexible, time-based client-provider engagement more closely than a fixed-duration distribution primitive. [2]

## Base and Base Sepolia availability

The official Sablier Flow deployment documentation lists Flow v3 deployments on Base and Base Sepolia. At collection time, the Base Sepolia Flow v3 address is shown as `0xc1ba5a41936aaab0ff920446db556efe17fc1c5d`; the Base mainnet Flow v3 address is shown as `0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b`. Deployment addresses and version status must be revalidated from the official documentation before environment activation. [3]

## Alternative retained for comparison

Superfluid documents money streaming and distribution pools, including SDK and smart-contract integration paths. It remains a viable future comparison candidate if its token model and lifecycle semantics better fit Paytray after the Flow testnet spike. [4]

## Sources

[1]: https://docs.sablier.com/concepts/streaming
[2]: https://github.com/sablier-labs/evm-monorepo/tree/main/flow
[3]: https://docs.sablier.com/guides/flow/deployments
[4]: https://docs.superfluid.org/
