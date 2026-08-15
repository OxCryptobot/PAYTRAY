# Webhook Replay-Store Integration Guidelines

## Scope and authority

PayTray signs outbound extension deliveries with HMAC-SHA256 and exposes `verifyWebhookSignature` plus `WebhookReplayGuard` for consumers that receive those envelopes. The guard is a **security boundary for duplicate delivery acceptance**, not a payment or settlement authority. A webhook may describe verifier-owned evidence, but accepting it must never create or infer an ERC-20 settlement transition.

The current `WebhookReplayGuard` is an in-process bounded map. It is appropriate for focused tests, a single-process development deployment, and local consumer verification. It is **not sufficient as the sole replay store for a horizontally scaled production consumer**, because two instances can accept the same event concurrently and an instance restart removes the map.

## Verification order

Consumers should process an envelope in this order:

1. Read the raw request body without reserialization and read `x-paytray-timestamp` and `x-paytray-signature` exactly as received.
2. Parse the timestamp as a positive integer in milliseconds and reject it when its absolute skew exceeds `WEBHOOK_SIGNATURE_TOLERANCE_MS`.
3. Recompute HMAC-SHA256 over the exact UTF-8 string `timestamp + "." + rawBody` using the configured secret and compare the 32-byte digest with a constant-time comparison.
4. Derive a stable replay key from the signer version, hook identifier, and projected envelope event identifier. The recommended form is `v1:{hookId}:{payload.eventId}`. If a producer does not provide an event identifier, use `v1:{hookId}:sha256:{sha256(rawBody)}` as a bounded fallback.
5. Atomically claim the replay key in the shared store. Reject the delivery when the claim reports that the key already exists.
6. Only after the claim succeeds, parse the JSON payload and invoke application logic. Application processing remains separately idempotent because a consumer crash after claiming but before completion must not create financial side effects.

Signature verification must occur before replay-key insertion. Invalid signatures must not poison the replay store. Timestamp rejection must occur before HMAC work where possible, and replay-store errors must fail closed rather than silently bypassing replay protection.

## Required shared-store interface

The consumer integration should provide an atomic operation equivalent to:

```text
claim(key, expiresAt) -> { claimed: true } | { claimed: false, reason: "duplicate" }
```

The operation must be atomic across all application instances, use a server-side expiry, and return a duplicate result when another instance has already claimed the key. A best-effort read followed by write is not safe because two instances can pass the read concurrently.

The expiry should be at least the accepted timestamp tolerance plus the maximum measured clock skew and a small operational buffer. A practical starting point is:

```text
replayRetention = signatureToleranceMs + maxClockSkewMs + 60 seconds
```

The store must expose claim success, duplicate rejection, store errors, expiry cleanup, and key cardinality as metrics. A store outage must produce a controlled rejection or retryable operational response; it must never switch to an unprotected accept path.

## PostgreSQL pattern

A PostgreSQL consumer can use a dedicated table with a primary key on the replay key:

```sql
CREATE TABLE webhook_replay_keys (
  replay_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX webhook_replay_keys_expiry_index
  ON webhook_replay_keys (expires_at);
```

The claim should use one transaction and database time. The insert must use `ON CONFLICT DO NOTHING RETURNING replay_key`; a returned row means the event was claimed, while no row means it is a duplicate. Expired rows may be deleted in a bounded maintenance job or opportunistically before the insert. The cleanup must never delete an unexpired key.

```sql
WITH inserted AS (
  INSERT INTO webhook_replay_keys (replay_key, expires_at)
  VALUES ($1, CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'))
  ON CONFLICT (replay_key) DO NOTHING
  RETURNING replay_key
)
SELECT EXISTS (SELECT 1 FROM inserted) AS claimed;
```

For high-volume consumers, use a bounded expiry-cleanup job, partitioning, or a retention policy rather than an unbounded table. The unique primary key remains the authoritative duplicate barrier.

## Redis pattern

A Redis consumer should use a single atomic `SET` operation with `NX` and `PX`, for example `SET {namespace}:{replayKey} 1 NX PX {retentionMs}`. Only `OK` is a successful claim. A null response is a duplicate. The key namespace must include the signature version and hook identity to prevent unrelated producers from colliding.

Redis availability, failover, and eviction policy must be treated as security dependencies. Do not deploy replay protection on an eviction policy that can remove unexpired keys, and do not accept a webhook when Redis is unavailable unless a separate durable inbox has already established the same unique constraint.

## Crash, retry, and multi-instance semantics

A simple replay guard intentionally rejects a duplicate after the key is claimed. That is correct for duplicate suppression but can reject a legitimate retry if the consumer crashes after claiming and before completing work. Production consumers should therefore separate **inbox claim** from **business processing**:

| State | Meaning | Required behavior |
|---|---|---|
| `claimed` | Signature and replay key are valid; processing has not completed. | Acquire a bounded lease and begin idempotent work. |
| `processed` | Business handling completed successfully. | Return success for duplicate deliveries without repeating side effects. |
| `retryable` | Processing failed after a valid claim. | Permit a controlled retry after lease expiry without accepting a new signature context. |
| `quarantined` | Payload is validly signed but violates consumer schema or policy. | Keep durable evidence and do not perform side effects. |

The business effect must have its own durable idempotency key, preferably the projected event identifier, and must be committed with the processing result. A process-local `WebhookReplayGuard` should not be presented as equivalent to this durable inbox pattern.

## Operational acceptance criteria

Before enabling horizontally scaled webhook consumption, verify that two concurrent consumers cannot both claim the same key, restart does not erase accepted keys, expired keys become claimable only after the configured retention, invalid signatures do not create keys, stale timestamps do not create keys, and store outages fail closed. Load tests should measure duplicate rejection, claim latency, cleanup lag, cardinality, and the ratio of valid signatures to accepted business effects.

This guidance does not authorize production settlement, chain mutation, ledger mutation, AI promotion, or automatic reviewer decisions. It only defines safe downstream webhook acceptance.
