# Paytray Payment-Stream Lifecycle

## Purpose

This specification defines the product-facing lifecycle for a freelancer-client time-payment stream. It separates wallet intent, protocol evidence, and Paytray’s off-chain ledger projection. No client request alone may establish economic finality.

## Authoritative sources

| Source | What it may establish | What it may not establish |
|---|---|---|
| Client/provider API command | User intent, requested action, idempotency key | On-chain inclusion, settlement, withdrawal, or ledger truth |
| Wallet transaction hash | Submission reference | Successful execution, finality, or decoded protocol outcome |
| Verified chain event | Protocol action at a specific block/log coordinate | Finality until confirmation policy is met |
| Finalized chain event | Economic protocol state under the configured finality policy | Paytray operational projection until ledger/outbox processing succeeds |
| Paytray ledger journal | Off-chain accounting projection and audit history | Replacement for the protocol’s ownership or token balances |

## States

| State | Owner | Entry evidence | Allowed next states | Product meaning |
|---|---|---|---|---|
| `draft` | Client/provider | Internal engagement preparation | `intent_created`, `failed` | A stream has not been requested from a wallet. |
| `intent_created` | Paytray API | Valid request, authorized engagement, durable idempotency record | `wallet_submitted`, `failed` | Paytray has recorded a request to start or update a stream. |
| `wallet_submitted` | Client wallet | Transaction hash supplied by the client | `chain_pending`, `failed` | The wallet reports broadcast intent; this is not yet authoritative. |
| `chain_pending` | Verifier | Transaction observed by RPC/indexer | `chain_included`, `failed` | Transaction is observed but not yet included. |
| `chain_included` | Verifier | Matching protocol event at block/log coordinate | `chain_finalized`, `failed` | Event was included and decoded, but is awaiting configured finality. |
| `chain_finalized` | Verifier | Confirmation/finality policy satisfied | `ledger_reflected`, `paused`, `cancel_finalized`, `withdrawal_finalized`, `disputed` | The protocol action is accepted as final for Paytray’s product view. |
| `ledger_reflected` | Ledger worker | Exactly-once journal entry and projection update | `paused`, `cancel_requested`, `withdrawal_pending`, `disputed` | Paytray’s durable product projection reflects verified protocol truth. |
| `paused` | Verifier | Finalized protocol pause event | `wallet_submitted`, `cancel_requested`, `disputed` | Accrual is paused according to protocol semantics. |
| `cancel_requested` | Client/provider | Authorized cancel/void intent | `wallet_submitted`, `failed` | A stop/void transaction is requested; availability must remain based on verified state. |
| `cancel_finalized` | Verifier | Finalized protocol cancel/void event | `withdrawal_pending`, `withdrawal_finalized`, `disputed` | The stream cannot continue; withdrawals follow protocol semantics. |
| `withdrawal_pending` | Client/provider | Recipient-directed withdrawal intent | `wallet_submitted`, `failed` | A recipient has requested withdrawal; no local balance is mutated yet. |
| `withdrawal_finalized` | Verifier + ledger worker | Finalized withdrawal event and exactly-once journal entry | `ledger_reflected`, `cancel_finalized`, `disputed` | The provider withdrawal is confirmed by protocol evidence. |
| `disputed` | Paytray operations | Durable dispute case, linked to stream and evidence | `ledger_reflected`, `cancel_finalized`, `failed` | An off-chain workflow restricts product actions; it does not fabricate chain reversal. |
| `failed` | Paytray API/verifier | Terminal validation, RPC, or protocol error | `intent_created`, `wallet_submitted`, `draft` | The requested action did not reach a valid product state. |

## Transition rules

1. API handlers may create `intent_created`, record wallet submission, and create a dispute record. They may not write `chain_included`, `chain_finalized`, `ledger_reflected`, or `withdrawal_finalized`.
2. The verifier may write a chain state only after matching stream identity, chain ID, protocol contract, token, sender, recipient, transaction hash, block number/hash, log index, and supported event schema.
3. The ledger worker may create a financial journal entry only from a finalized source event. A unique source-event/entry-type constraint enforces exactly-once projection.
4. All state mutations require an idempotency or event key, correlation ID, actor/source, timestamp, and immutable audit entry.
5. A reorg invalidates only non-final events. Finality depth and reorg handling are environment configuration, not UI guesswork.
6. Product-visible balances are derived from the latest verified protocol state and ledger projection. They are never a mutable JavaScript number updated by a user request.
7. Withdrawal actions must be recipient-directed in the product UI. The protocol adapter validates the recipient/beneficiary semantics before emitting an intent.

## Required evidence fields

```text
chainId, protocolContractAddress, tokenAddress, tokenDecimals,
streamProtocolId, paytrayStreamId, transactionHash, blockNumber,
blockHash, logIndex, eventName, eventPayloadHash, confirmationCount,
finalityStatus, observedAt, finalizedAt, correlationId, idempotencyKey
```

## Development-only simulation policy

A test-only adapter may produce deterministic mock protocol events. It must declare `source = mock_adapter`, remain unavailable in production configuration, and never reuse the `chain_finalized` or `ledger_reflected` labels without the explicit development indicator in test output.
