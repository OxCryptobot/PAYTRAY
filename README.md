# PayTray

PayTray is a Phase 1 skeleton for an AI platform that combines expert discovery, real-time communication, and blockchain payments.

This repository has been reduced to a minimal starting point for development:

- `MasterBlueprint.md` defines the target architecture and roadmap.
- `packages/backend` contains the backend skeleton.
- Root scripts are scoped to the backend workspace only.

## Start Here

```bash
npm install
npm run backend:dev
```

## Current Scope

The codebase is intentionally small and focused on Phase 1 infrastructure work:

- identity and trust primitives
- minimal API foundation
- database schema initialization
- baseline testing and linting

## Phase 1 API Contract Notes

The backend currently exposes stable Phase 1 skeleton contracts under `packages/backend/server.js`.

- Profile endpoints:
	- `POST /api/profiles` creates or updates the authenticated wallet profile and returns `{ success, profile, exists }`.
	- `GET /api/profiles/search?q=...` returns `{ success, query, count, results }`.
	- `GET /api/profiles/trending` returns `{ success, count, profiles }`.
- Payment stream endpoints:
	- `GET /api/payments/streams` returns `{ success, count, streams }` scoped to the authenticated wallet.
	- `GET /api/payments/streams/:streamId` and `/stats` enforce participant-only access.
- Error behavior:
	- Validation failures return HTTP 400.
	- Authenticated but unauthorized actions return HTTP 403.
	- Wallet verification uses `POST /api/wallet/verify/challenge` then signed challenge submission to `POST /api/wallet/verify`.

## Phase B, C, D API Surface

- Phase B MVP coherence loop:
	- `POST /api/discovery/search` for structured filters and ranked candidates.
	- `POST /api/matches/:sessionId/select` and `POST /api/matches/:sessionId/handoff` for match-to-chat context handoff.
	- `POST /api/threads/:threadId/messages` and `GET /api/threads/:threadId` for session communication artifacts.
	- `POST /api/reputation/events` and `GET /api/reputation/:wallet` for outcome capture.
- Phase B payments UX:
	- Streams start in `submitted` state and can transition through `included` then `reflected` via `POST /api/payments/streams/:streamId/confirm`.
	- Confirmation transitions are strict: backward or duplicate transitions return HTTP 409 conflict errors.
	- Stream creation supports `x-idempotency-key` to safely replay client retries without duplicate stream creation.
- Phase C intelligence:
	- `POST /api/intelligence/ranking/train` and `GET /api/intelligence/ranking/model`.
	- `POST /api/intelligence/ranking/evaluate` for offline ranking quality metrics.
	- `POST /api/intelligence/conversations/:threadId/assist`.
	- `POST /api/intelligence/risk/payments/score` with severity, reason codes, and recommended action.
	- Discovery candidates include ranking score breakdown and explanation metadata.
- Phase D scale/resilience:
	- Reliability-gated chain expansion via `POST /api/ops/chains/enable`.
	- Chain expansion additionally requires a minimum reliability sample size before target checks are evaluated.
	- Queue and reconciliation endpoints under `/api/ops/queue/*` and `/api/ops/reconciliation/run`.
	- Queue job visibility and processing are scoped to the job owner wallet unless admin scope is present.
	- Failed/dead queue jobs can be redriven via `POST /api/ops/queue/jobs/:jobId/retry`.
	- SLO metrics via `GET /api/ops/slo`, including operational backlog counters for queue/webhook pipelines.
	- Runtime state persistence via `POST /api/ops/state/persist`.
	- Webhook delivery processing under `/api/ops/webhooks/*`.
	- Failed/dead webhook deliveries can be redriven via `POST /api/ops/webhooks/deliveries/:deliveryId/retry`.
	- Extension hook registration under `/api/extensions/hooks`.
	- Public API endpoints under `/api/public/*` (requires `PUBLIC_API_KEY`).

## Hardening Sequence (Post-Phase D)

- Auth scopes:
	- Wallet login now uses a challenge-first flow via `POST /api/auth/challenge` and `POST /api/auth/login`.
	- Challenge payloads include nonce and expiry and are one-time use.
	- Login can request a least-privilege scope subset by sending `scopes: string[]` to `POST /api/auth/login`; escalation beyond wallet defaults is rejected.
	- Challenge issuance is rate limited per wallet and client IP.
	- Login attempts are rate limited per wallet and client IP.
	- JWT access tokens now include scope claims.
	- Sensitive intelligence/ops/extensions routes enforce scope checks.
- Durable state:
	- In-memory runtime state snapshots persist to `STATE_FILE_PATH`.
	- Snapshot restore runs at server startup.
- Webhook reliability:
	- Domain events enqueue delivery jobs for matching hooks.
	- Webhook processing supports retry/dead states and dry-run execution.
	- Outbound webhook payloads are signed as `x-paytray-signature` (`v1=` HMAC) when `WEBHOOK_SIGNING_SECRET` is configured.
	- Webhook delivery processing and visibility under `/api/ops/webhooks/*` are scoped to the hook owner wallet (unless admin scope is present).
- Realtime reliability:
	- `POST /api/livekit/token` returns HTTP 503 when LiveKit credentials are missing instead of issuing placeholder auth tokens.
	- LiveKit session tokens are signed with `LIVEKIT_API_SECRET` rather than the core JWT auth secret.

The old peerstream implementation, deployment cruft, and unrelated application surface have been removed so the team can build forward from a clean baseline.