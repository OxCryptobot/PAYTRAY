# PayTray System Diagnostics Report

Verified state: 94 backend tests pass, lint clean. Backend only; no frontend or contracts in this repo.

## 1. Corrections to earlier reports

Earlier versions of this report overstated the learning system. Findings from this review:

| Earlier claim | Reality | Action taken |
|---|---|---|
| Ranker and risk model "learn on their own" and change live decisions | Their labels come from client-submitted `POST /api/reputation/events` and client-driven `confirm` calls. Any user could post fake outcomes for any wallet and steer ranking or risk | Learners are now **experimental-only**. Discovery uses fixed weights with neutral outcome features, risk uses rules only, exploration bonus is 0. Status endpoint reports `mode: experimental_only` |
| Inverse-propensity weighting "corrects position bias" | Examination propensity was assumed, not measured; selection bias is not removed | Comment corrected; weight is optional and not used for serving |
| Scheduled self-review "re-runs governance" | Re-running governance on unchanged data could promote on stale evidence | Review now only reports staleness (`no_new_data`) |
| Refresh tokens | `authenticateToken` accepted refresh tokens as access tokens | Fixed: access type required (test added) |
| Snapshot persistence | Concurrent flushes could overlap, and a failed write could clear the dirty flag | New `SnapshotWriter`: serialized writes, revision tracking, retry after failure (3 tests) |
| `MasterBlueprint.md` | Describes a proposal, partly stale | Marked historical |

| Chain receipt = "trusted settlement" label | A receipt only proves some tx was mined; amount, recipient and token were never decoded, and one txHash could confirm many streams | **Trusted labels are disabled** (`settlement_details_unverified`). Learners and legacy trusted flags are reset by a one-time snapshot migration (`lib/learningTrust.js`). A txHash can bind to only one stream |
| Rate limiter 50k cap evicted live windows | Evicting active keys lets an attacker flush other clients' limits | Active keys are never evicted; at capacity, new keys get 429 |

## 2. Current system snapshot

| Area | State |
|---|---|
| API | ~75 routes: auth, profiles, discovery, matching, threads, reputation, payments, contracts, trust, intelligence, ops, webhooks, public API, `/metrics` |
| Auth | Wallet challenge/sign login, scoped JWTs bound to a server-side session (`sid`). `POST /api/auth/refresh` rotates refresh tokens and revokes the family on reuse; `logout`, `logout-all`, `GET /api/auth/sessions`. Sessions persist in the state snapshot. Rate limits are in-process with bounded memory |
| Payments | State machine and ledger. Confirmation is chain-verified when `CHAIN_RPC_URL` is set; otherwise legacy client-driven (not trusted for learning) |
| Storage | In-memory Maps plus JSON snapshot. Postgres pool and migration exist but are not used for domain data |
| Intelligence | Rules for production. Experimental online learners (`lib/learning.js`) run in shadow for diagnostics |
| Observability | JSON logs, `/metrics` (ops scope), SLO endpoint |
| CI | `.github/workflows/ci.yml`: lint and tests on Node 18/20/22 (not yet run on GitHub) |
| Wired | `lib/chainVerifier.js` in stream confirmation |
| Informational only | `lib/semantic.js` feeds `semanticMatch` in discovery results |

## 3. Gap register

| # | Gap | Sev | Status | Next step |
|---|---|---|---|---|
| G1 | Domain state not in Postgres; single instance, crash window between flushes | P0 | Open | Repository layer, write-through, migrate from snapshot |
| G2 | On-chain verification of payments | P0 | **Wired**: with `CHAIN_RPC_URL` set, `confirm` requires `txHash`, `included` needs a receipt, `reflected` needs `CHAIN_MIN_CONFIRMATIONS`; `CHAIN_REQUIRE_VERIFICATION=true` fails closed (503) without RPC. Tested with an injected verifier; not run against a live RPC | Background watcher and reorg re-check job (not built), amount/recipient decoding from logs. txHash is now unique per stream |
| G14 | Outcome labels are untrusted | P0 | **Reopened**: labels stay untrusted and nothing trains the learners until payment amount/recipient/token are decoded from logs and matched to the stream | Decode ERC-20 Transfer logs; then re-enable counterparty labels; per-wallet influence caps |
| G13 | No refresh/rotation/revocation | P1 | **Closed**: `lib/sessions.js`, immediate revocation (access tokens need an active `sid`; tokens without one are rejected, so tokens issued before this change stop working). 4 e2e + 3 unit tests | Admin revoke by wallet; device metadata |
| G3 | `server.js` ~3,300-line monolith | P1 | Open | Split into routers and services |
| G10 | Rate limits are in-process | P1 | Partly closed: expired windows swept; active keys never evicted; 429 at 50k-key capacity. Per-instance, not shared across replicas | Redis-backed async limiter |
| G5 | Skill match is exact-string | P1 | Partly closed: discovery returns `semanticMatch` (0-1) as an informational field; **not used in ranking** | Evaluate offline against trusted outcomes before it influences score |
| G4 | No click/select labels or counterfactual evaluation | P1 | Impressions logged; evaluation open | Log selects, off-policy evaluation before enabling any learned ranking |
| G9 | No tracing; alerts undefined | P1 | `/metrics` exists | OpenTelemetry, alert rules |
| G7 | Conversation assist is keyword matching | P1 | Open | LLM provider behind a flag with eval set and redaction |
| G11 | No load or state-machine fuzz tests | P2 | CI added | k6 profile, property tests |
| G12 | No client | P1 | Open | Client and OpenAPI spec |

## 4. Promotion criteria for learned models

A learned model may serve production decisions only when all hold:

1. Labels come from verified events (on-chain settlement, counterparty-confirmed completion), not self-reported.
2. Offline evaluation on held-out data beats the rule baseline with a stated margin.
3. A canary slice shows no regression in disputes or conversion; automatic rollback is wired to the SLO metrics.
4. Per-wallet influence is capped to resist Sybil and wash-trading.

## 5. Recommended next batches

1. **G1**: Postgres write-through, which also enables multiple replicas (with G10).
2. **G3**: router split (also makes G1 and G10 cleaner).
3. Then promote learners under section 4.
