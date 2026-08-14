# Phase 1 API Compatibility Inventory

**Purpose:** Preserve user-facing API behavior while migrating Paytray from process-local simulated streams to a verifier-backed, durable financial core.

## Existing public and authenticated surfaces

| Area | Current endpoints | Compatibility treatment |
|---|---|---|
| Health | `GET /health`, `GET /api/health` | Preserve liveness response; add separate readiness/dependency status without claiming payment settlement. |
| Wallet identity | `POST /api/auth/challenge`, `POST /api/auth/login`, `POST /api/wallet/verify/challenge`, `POST /api/wallet/verify` | Preserve challenge-first auth. Continue to reject refresh tokens as bearer access credentials. |
| Profiles/discovery | `/api/profiles*`, `POST /api/discovery/search`, `POST /api/matches/:sessionId/select`, `POST /api/matches/:sessionId/handoff` | Preserve existing contracts through the engagement MVP; introduce pagination/versioning before external-public expansion. |
| Collaboration | `/api/threads/*`, `/api/livekit/token`, `/api/sessions/artifacts` | Preserve participant authorization and keep collaboration operational when payment data is delayed. |
| Streams | `/api/payments/streams*` | Deprecate participant-written finality. Add `/api/v2/payment-intents` and `/api/v2/streams` before removing simulated transitions. |
| Ledger/disputes | `/api/ledger/:wallet`, `/api/payments/streams/:streamId/dispute*` | Rebuild projections from journal/event data. Preserve access control but return source/finality metadata. |
| Operations | `/api/ops/*`, `/api/extensions/hooks`, `/api/public/*` | Keep privileged operations behind explicit roles; add event lag/reconciliation/readiness signals and restricted webhook egress. |

## Payment API migration rules

1. **Do not break `GET` stream/list/stats consumers silently.** During migration, current endpoints return a compatibility representation with `source`, `lifecycleState`, and `finalityStatus` fields.
2. **Do not accept a user request as chain truth.** Current `POST /api/payments/streams/:streamId/confirm` behavior is development-only compatibility debt. Production routes must not allow a participant to write `included`, `finalized`, or `reflected` states.
3. **Introduce v2 as command/event oriented.** `POST /api/v2/payment-intents` creates durable intent; a wallet submission reference is recorded separately; verifier events project the stream state.
4. **Use explicit deprecation headers and documentation.** Keep v1 behavior only behind non-production/development configuration until client migration completes.
5. **Treat token fields as breaking changes.** Replace `token: "USDC"` with `tokenAddress`, `chainId`, `decimals`, and base-unit amount fields in v2. A human display symbol may remain informational.

## Characterization coverage

The existing integration suite currently validates 59 API flows, and the payment-domain suite adds 5 pure-domain checks. Before changing a v1 payment route, add characterization tests for its response body, error status, participant access, idempotency behavior, and lifecycle output. New v2 tests must cover duplicate submission, duplicate chain events, out-of-order events, reorg invalidation, restart, and concurrent verifier execution.
