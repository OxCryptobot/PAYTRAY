# PayTray Final Production Release Checklist

**Purpose.** This checklist is an operator approval artifact for a future production release of PayTray. It is read-only documentation and does not deploy services, submit transactions, move funds, approve AI promotion, or change settlement policy.

> **Release rule:** A green configuration preflight is necessary but insufficient. Production release requires explicit human approval after every financial-integrity and operational gate is evidenced.

## Current verified boundary

| Area | Current evidence | Release interpretation |
|---|---|---|
| Settlement chain | Base Sepolia, chain ID `84532` | Safe testnet default; retain for all trial validation. |
| Mainnet mode | `PAYMENT_MAINNET_ENABLED=false` in local preflight | Mainnet settlement remains disabled. Any mainnet change requires a separate explicit approval. |
| Protocol | Sablier Flow v3 with configured Base Sepolia contract | Verify contract and token registry again in the target environment. |
| Railway settings | Project settings unavailable from the current authenticated context | Do not infer values; obtain authenticated, redacted settings evidence before deployment. |
| Release approval artifact | `blocked` without explicit human approval | Correct fail-closed state. |
| AI promotion | `shadow_only` | No candidate ranking or collaboration model may be promoted automatically. |
| Financial mutation | Verifier-owned chain evidence and durable ledger only | API, AI, chat, and operator reports cannot establish settlement. |

## Mandatory gates before any production deployment

| Gate | Required evidence | Owner | Pass condition |
|---|---|---|---|
| Railway configuration | Authenticated, redacted environment comparison for database, JWT, HTTPS RPC, protocol contract, token registry, webhook signing, verifier threshold, and mainnet flag | Operator | Target values match the approved release configuration; secrets are never copied into reports. |
| Database | Migration check through migration 014 plus backup/restore evidence | Database operator | Migrations complete successfully and restoration is verified. |
| Settlement policy | Chain ID, protocol address, token registry, decimals, sender/receiver rules, and confirmation policy | Protocol operator | Base Sepolia remains selected unless a separately approved mainnet change exists. |
| Verifier | Fresh durable cursor, configured RPC, bounded polling, cursor persistence, and chain-event audit evidence | Protocol operator | Verifier classification is `fresh`; `missing`, `stale`, or `not_configured` blocks release. |
| Reconciliation | Durable reconciliation report with no unresolved finalized-without-ledger, transaction-evidence, unlinked-event, or projection-lag issues | Finance/operator team | Report status is `ok`; any attention state blocks release until reviewed. |
| Shadow evaluation | Candidate baseline comparison, sample size, confidence bound, rollback target, and segment evidence | AI review owner | Quality gate passes, but promotion remains `shadow_only` until human approval. |
| Human review queue | Pending shadow-run review and reviewer decision evidence | AI review owner | No unreviewed blocking runs remain; every approved pilot has reviewer identity, notes, and rollback context. |
| Collaboration intelligence | Provenance, retention, latency, cost, raw-content exclusion, and human-override evidence | Product/operator team | Advisory outputs are attributable and cannot mutate payment, ledger, outcome, reputation, or settlement state. |
| Webhooks | SSRF validation, delivery-time DNS revalidation, signing, retry backoff, and dead-letter handling | Platform operator | Only approved HTTPS destinations are enabled and retry behavior is bounded. |
| Security | Wallet challenge/session checks, operator scopes, rate limits, secret handling, and audit logs | Security owner | No known critical authorization or secret-exposure issue remains open. |
| Smoke test | Authenticated non-production or controlled production smoke test with no live funds | Release operator | Discovery → engagement → intent → verifier-read-only status path succeeds without claiming settlement prematurely. |
| Final approval | Completed `GET /api/v2/ops/release-approval` or `backend:release:approval:check` artifact plus reviewer identity and timestamp | Authorized human approver | Artifact is eligible and explicit human approval is recorded. |

## Required release controls

The release must be paused immediately if the Railway project settings cannot be authenticated, if the verifier cursor is stale or missing, if reconciliation reports delayed or missing financial projections, if a shadow candidate lacks a rollback target, or if any endpoint attempts to treat an API request, participant report, AI output, or collaboration event as chain settlement evidence.

The first deployment should use Base Sepolia and a non-production token registry. No production mainnet transaction, live fund transfer, or user-data migration is authorized by this checklist. Mainnet enablement requires a separate review of chain ID `8453`, `PAYMENT_MAINNET_ENABLED=true`, token and protocol allowlists, finality policy, rollback plan, and explicit human approval.

## Sign-off record

| Role | Name or wallet | Decision | Timestamp | Notes |
|---|---|---|---|---|
| Release operator | _To be completed_ | _Pending_ | _Pending_ | _Pending_ |
| Protocol/finance reviewer | _To be completed_ | _Pending_ | _Pending_ | _Pending_ |
| AI/data reviewer | _To be completed_ | _Pending_ | _Pending_ | _Pending_ |
| Security reviewer | _To be completed_ | _Pending_ | _Pending_ | _Pending_ |

**Current decision: `BLOCKED_PENDING_EXPLICIT_HUMAN_APPROVAL_AND_AUTHENTICATED_RAILWAY_SETTINGS`.**
