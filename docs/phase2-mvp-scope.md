# PayTray Phase 2 MVP Scope

**Product loop:** discover an expert → preserve match context → collaborate in one real-time channel → request one-chain testnet payment for time → observe verified payment state → capture trusted outcomes.

**Scope boundary:** one expert vertical, one real-time channel, Base Sepolia testnet, one ERC-20 payment mode, and one interpretable ranking baseline. Phase 2 is a validation loop, not production settlement or multi-chain scale.

## MVP contracts

| Contract | Required fields | Authority |
|---|---|---|
| Expert profile | wallet, name, skills, availability, rate, timezone, language, verification state, outcome summary | Durable off-chain profile store; verification signals are separately sourced. |
| Discovery result | expert ID, match score, score explanation, matched filters, evidence references, generated-at timestamp | Explainable ranking service. |
| Engagement context | search brief, chosen expert, ranking explanation, proposed terms, participant IDs, conversation thread ID, payment intent ID | Engagement service; it does not settle payments. |
| Payment intent | chain ID, token contract, decimals, exact base-unit amounts, sender/recipient, idempotency key, lifecycle status | Durable financial core; chain finality remains external until verified. |
| Outcome event | engagement ID, event type, actor, evidence reference, occurred-at, provenance, confidence | Outcome service; only verified payment/session evidence may affect trust and ranking. |

## Pilot success metrics

| Metric | Definition | Initial target |
|---|---|---:|
| Discovery relevance | Share of pilot searches where the client selects one of the top three results | ≥ 60% |
| Match-to-conversation conversion | Selected matches that create or resume an authorized conversation | ≥ 70% |
| Conversation-to-payment-intent conversion | Authorized conversations that create a durable payment intent | ≥ 35% |
| Payment evidence latency | Median time from wallet submission to verified testnet event | Measure baseline first; no unverified claim |
| Engagement completion | Sessions with a verified completion outcome and no unresolved dispute | ≥ 80% |
| Duplicate financial effects | Duplicate ledger/outbox effects per replayed event | 0 |
| Repeat engagement | Pilot clients who start a second engagement with the same or another expert | Measure baseline first |

## Non-goals

Phase 2 will not add multi-chain routing, autonomous deal negotiation, opaque neural ranking, production mainnet settlement, generalized public APIs, or unverified reputation updates. The client must continue to distinguish a payment intent, wallet submission, chain inclusion, finality, and ledger reflection.

## Delivery gates

1. A discovery result is explainable and traceable to profile/filter evidence.
2. A selected expert carries the original search context into the authorized collaboration thread.
3. Collaboration remains usable when payment confirmation is delayed or unavailable.
4. Only verified protocol evidence advances payment state toward ledger reflection.
5. Outcome events are durable, provenance-linked, replay-safe, and excluded from ranking until their trust policy is satisfied.
6. Pilot metrics can be computed from durable event records rather than ad hoc process logs.
