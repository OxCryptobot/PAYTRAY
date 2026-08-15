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

PayTray now provides the `webhook_replay_claims` table in migration `014_webhook_replay_claims.sql` and a PostgreSQL adapter in `packages/backend/lib/durableWebhookReplayStore.js`. The table uses a primary key on the replay key and an expiry index:

```sql
CREATE TABLE webhook_replay_claims (
  replay_key VARCHAR(512) PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX webhook_replay_claims_expiry_index
  ON webhook_replay_claims (expires_at);
```

The delivered adapter claims a key with an atomic insert-or-expired-row-update. A returned row means the event was claimed; an empty result means another consumer already holds an unexpired claim. The query also prunes expired rows opportunistically. The separate `backend:idempotency:cleanup` command removes expired payment idempotency records in bounded `FOR UPDATE SKIP LOCKED` batches; it does not delete unexpired records or mutate settlement state.

```sql
WITH claimed AS (
  INSERT INTO webhook_replay_claims (replay_key, expires_at)
  VALUES ($1, $2)
  ON CONFLICT (replay_key) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
    WHERE webhook_replay_claims.expires_at <= $3
  RETURNING replay_key
)
SELECT replay_key FROM claimed;
```

Consumers should call `verifyWebhookSignatureWithReplayClaim` or the concrete `verifyWebhookSignatureWithPostgresReplayStore` adapter so exact-body HMAC and timestamp checks complete before the durable claim. A store error fails closed; no unprotected fallback is permitted.

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
