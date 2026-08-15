# PayTray Remaining Build and Release Checklist

**Project:** PayTray — AI-enabled time-to-money platform connecting expert discovery, real-time collaboration, and ERC-20 payment streams.

**Branch:** `paytray/batch-delivery`

**Current pushed branch:** `origin/paytray/batch-delivery` (verify the exact tip with `git rev-parse HEAD` and `git rev-parse origin/paytray/batch-delivery`).

**Safety boundary:** Base Sepolia (`84532`) remains the safe settlement default. The verifier and ledger remain the economic authority. AI remains `shadow_only`. No live funds, mainnet transaction, production deployment, real user-data migration, fabricated approval, or fabricated signing key is authorized by this checklist.

## 1. Current delivery state

The latest multi-phase tranche is validated and pushed to the remote branch. It adds collaboration degraded-state health, a real ready-PostgreSQL route-contract verifier, versioned public extension schemas, and failure-mode coverage on top of the pushed AY/BA capabilities.

| Batch | Capability | State | Evidence |
|---|---|---|---|
| AP | Ed25519 canonical release payload construction | Pushed | `19a78e0a5bf53ea9e63f70af74b470a8e330d06e` |
| AQ | Detached signed-payload verification and tamper rejection | Pushed | `c447a5218bb221deac08df4b490ac56dbe27ff8e` |
| AR | Read-only paginated/filterable financial audit events with metadata redaction | Pushed | `packages/backend/lib/auditLogService.js`; `GET /api/v2/ops/audit/events` |
| AS | Production chain/protocol/token-registry consistency validation | Pushed | `packages/backend/lib/payments/tokenRegistry.js`; deployment preflight |
| AT | Discovery impression → engagement → outcome lineage | Pushed | `packages/backend/lib/discoveryLineageService.js`; `GET /api/v2/ops/discovery/lineage` |
| AU | Isolated PostgreSQL recovery evidence with backup fingerprint and restore verification | Pushed | `packages/backend/scripts/verify-recovery-evidence.mjs`; disposable restore returned `verified` |
| AV | Verifier operations evidence CLI and scoped operator endpoint | Pushed | `packages/backend/lib/verifierOperationsEvidence.js`; `GET /api/v2/ops/verifier/operations` |
| AW | Route-level contracts plus ready-PostgreSQL integration fixture | Pushed | `packages/backend/scripts/verify-ready-postgres-contracts.mjs`; isolated CI target returned `status: verified` |
| AX | Read-only ERC-20 symbol/decimals/chain metadata probe | Pushed | `packages/backend/lib/payments/tokenMetadataProbe.js` |
| AZ | Lineage-backed evaluation export coverage | Pushed | `packages/backend/lib/evaluationExport.js` |
| BC | Controlled Base Sepolia smoke harness with disposable-data and no-chain-mutation guards | Pushed | `packages/backend/scripts/verify-phase2-loop.mjs` |
| BD | Versioned v2 operations, lineage, and public extension schemas | Pushed | `packages/backend/lib/extensionContracts.js`; `/api/v2/extensions/contracts`; updated API documentation |
| AY | Durable outbox and operator delivery health | Pushed | `packages/backend/lib/outboxDeliveryService.js`; `GET /api/v2/ops/outbox/health` |
| BA | Bounded advisory-AI provider and retrieval boundary | Pushed | `packages/backend/lib/advisoryAiBoundary.js`; `POST /api/v2/intelligence/advisory` |
| BB | Collaboration degraded-state health | Pushed | `packages/backend/lib/collaborationHealth.js`; `GET /api/v2/collaboration/health` |
| BF | Durable reviewer-decision audit records | Pushed | `810868f97ab0b8706dfde5747830d9e935eb7c67`; `shadow_review_recorded` and `shadow_review_replayed` financial audit events |
| BG | Verifier-owned engagement payment-state surface | Pushed | `a40adb4f4a83e15d9806ebefc7047641085784d6`; `GET /api/v2/engagements/:engagementId/payment-state` |
| BH | Durable outbox delivery processor | Pushed | `a40adb4f4a83e15d9806ebefc7047641085784d6`; `POST /api/v2/ops/outbox/process` |
| BI | Ready-PostgreSQL BG/BH verification and webhook signature security | Pushed | `124701ba78d79d96f2abd51ccd59580e9db86a49`; extended `verify-ready-postgres-contracts.mjs`, shared exact-body HMAC signer/verifier, timestamp tolerance, stable event identifiers, and bounded replay guard |
| BJ | End-to-end simulated webhook replay-load validation and shared durable-store guidance | Pushed | `210f2573025ef1fe7bbff2965fc63172ac3b68f6`; 100 captured deliveries, exact HMAC verification for every event, duplicate replay rejection, and PostgreSQL/Redis atomic-claim integration guidance |
| BK | Shadow-review approval and isolated-recovery operator runbook | Implemented locally | `docs/shadow-review-and-recovery-operator-runbook.md`; non-submitting `approved_pilot` templates, post-submit verification, isolated restore commands, and exact 17-migration evidence requirements |
| BL | Durable idempotency expiry cleanup and shared webhook replay claims | Pushed | `cbbec7311f8e98547226af6a50567e338ac91601`; `backend:idempotency:cleanup`, migration `014_webhook_replay_claims`, atomic PostgreSQL replay claim adapter, signature-before-claim verifier boundary, and bounded cleanup tests |
| BM | Durable verifier-owned trust-signal persistence and derivation | Pushed | `cffc9c2`; migration `015_verified_trust_signals`, verified-outcome-only derivation, idempotent participant-specific signals, neutral dispute evidence, operator listing, and permanent `eligibleForRanking=false`. |
| BN | Durable webhook inbox state machine | Pushed | `cffc9c2`; migration `016_webhook_inbox`, atomic first claim, lease reclaim, processed/retryable/quarantined states, bounded retry, raw-content rejection, and health evidence. |
| BO | Durable extension hooks and production outbox worker | Pushed | `cffc9c2`; migration `017_extension_hooks`, durable v2 hook registration/listing, explicit `OUTBOX_WORKER_ENABLED=true` entrypoint, bounded polling/leases/batches, signing-secret requirement, and graceful shutdown. |
| BP | Versioned public extension OpenAPI and dependency-free SDK | Pushed | `d63c046`; public `/api/v2/extensions/openapi.json`, runtime-to-OpenAPI contract verifier, `@paytray/sdk` Node 18+ client with TypeScript declarations, HTTPS registration helper, structured API errors, and read-only safety metadata. |
| BQ | Explicit production idempotency-cleanup schedule contract | Pushed | `7f7a264`; opt-in `backend:idempotency:cleanup:run`, read-only `backend:idempotency:cleanup:check`, bounded 15-minute/500-record defaults, production-time override rejection, and external-host scheduler guidance. |
| BR | Unified target-operations configuration preflight | Pushed | `de44809`; read-only `backend:target:operations:check` composes redacted Railway settings, Base Sepolia policy, HTTPS RPC, worker/housekeeping opt-ins, and named blockers; it always emits `releaseEligible: false`. |
| BS | Production Base Sepolia verifier-worker entrypoint | Implemented locally | Explicit `VERIFIER_WORKER_ENABLED=true` gate, HTTPS RPC/protocol/token consistency, transactional bounded polling, durable cursor projection, and graceful shutdown. |
| BT | Reproducible CI and shared quality gate | Implemented locally | `.github/workflows/paytray-quality.yml`, `backend:quality:check`, locked npm install, Node 22, full tests/lint/extension contract, migrations, and isolated PostgreSQL route checks. |
| BU | HTTP and rate-limit hardening | Implemented locally | Explicit proxy trust, bounded JSON/urlencoded request body size, expired-key eviction, and configurable rate-limit key budget. |

The BB/AW/BD/BF/BG/BH/BI/BJ/BL/BM/BN/BO/BP/BQ/BR/BS/BT/BU tranche now includes durable trust-signal, webhook inbox, durable-hook, worker, OpenAPI, SDK, housekeeping-schedule, target-operations-preflight, verifier-worker, CI, and HTTP hardening coverage; the latest validation target is **58 test files and 249 tests**, pending the final full-suite run, ESLint, migration code validation through migration 017, the runtime-to-OpenAPI contract verifier, a 100-event simulated webhook delivery/replay-load test, exact outbound HMAC digest tests, malformed/tampered signature rejection, timestamp skew rejection, replay detection and expiry coverage, durable idempotency cleanup tests, PostgreSQL replay-claim tests, focused verifier-owned payment-state tests, durable outbox processor tests, extension-event contract tests, degraded-database API coverage, and isolated ready-PostgreSQL verification with `engagementPaymentState: true`, `extensionOpenApi: true`, `trustSignals: true`, `webhookInbox: true`, `outboxDryRun: true`, and worker configuration status `ready`. The release manifest is read-only; production approval and signed-payload generation remain blocked by genuine environment and human-evidence requirements.

## 2. Mandatory release blockers

These are not code defects that can be safely bypassed by the agent. They require authenticated environment access, controlled operational work, or explicit human decisions.

| Priority | Blocker | Required evidence | Current state | Clear condition |
|---:|---|---|---|---|
| P0 | Railway target settings unavailable | Authenticated, redacted comparison of database, JWT, HTTPS RPC, protocol contract, token registry, webhook signing, verifier threshold, chain, and mainnet flag | Pending; settings were unavailable | Railway gate reports matched settings without exposing secrets. |
| P0 | Full database recovery not verified in the target release environment | Backup fingerprint, isolated database restore log, catalog/table verification, and application connectivity check | AU verified a disposable local restore; target-environment evidence remains pending | Target recovery evidence changes from `schema_catalog_only` to `verified`. |
| P0 | Durable verifier not fresh | HTTPS RPC configuration, worker startup, cursor persistence, bounded polling, finality threshold, and chain-event audit evidence | `not_configured` in checked environment | Verifier status classification is `fresh`. |
| P0 | Final reconciliation evidence | Durable report after a fresh cursor, including projection lag and ledger linkage | Local report was clean, but target evidence is not complete | Report status is `ok` with no unresolved issues. |
| P0 | Pending shadow reviews | Baseline comparison, sample/confidence evidence, rollback target, reviewer identity, notes, and decision for every pending run | Pending reviews remain | No blocking review remains; promotion stays `shadow_only`. |
| P0 | Four human sign-offs | Real identity, decision, timestamp, scope, rollback acknowledgement, notes, and evidence references | All four rows are `Pending` | Authorized reviewers approve the same immutable release commit and artifact. |
| P0 | Operator Ed25519 key | Key injected through an approved secret manager as `RELEASE_SIGNING_KEY_PEM` | Not provided and must not be fabricated | Signed payload has a non-null signature and detached verification exits 0. |

## 3. Exact release-clearance sequence

The sequence below is the master operator checklist. Each step must be completed with evidence before the release artifact is regenerated.

### Environment and deployment evidence

- [ ] Authenticate to the Railway project and select the intended non-production/trial service.
- [ ] Capture redacted settings only; never copy secrets into reports or Git.
- [ ] Confirm `SETTLEMENT_CHAIN_ID=84532` and `PAYMENT_MAINNET_ENABLED=false` for the first release.
- [ ] Confirm the configured Sablier Flow v3 Base Sepolia contract.
- [ ] Confirm every enabled token has the correct chain, checksum address, protocol contract, symbol, and decimals.
- [ ] Confirm `PAYMENT_RPC_URL` is HTTPS and points to the approved Base Sepolia provider.
- [ ] Confirm webhook signing, verifier threshold, JWT, database, and operator scopes.
- [ ] Confirm durable outbox health reports `status: ok`, with no dead-letter events and bounded retry backlog.
- [ ] Run `npm run backend:outbox:health:check` and preserve its read-only evidence.
- [ ] Run `npm run backend:railway:trial:check` and obtain a matched settings result.

### Database and verifier evidence

- [ ] Run `DATABASE_URL="$DATABASE_URL" npm run backend:migrations:check` in the target environment.
- [ ] Create a protected PostgreSQL backup and record its SHA-256 fingerprint.
- [ ] Restore into a separate isolated database; never overwrite the source database during verification.
- [ ] Verify all PayTray tables, indexes, migration records, and required columns after restore.
- [ ] Run a read-only application connectivity check against the restored database.
- [ ] Start the configured verifier worker with bounded polling and the approved finality threshold.
- [ ] Verify the durable cursor is persisted and classified `fresh`.
- [ ] Preserve chain-event audit evidence for the scan and any replay/reorg decisions.
- [ ] Run the durable reconciliation report after the cursor is fresh.
- [ ] Resolve every finalized-without-ledger, unlinked-event, transaction-evidence, and projection-lag issue before proceeding.

### AI, data, and collaboration evidence

- [ ] Export the candidate-versus-baseline ranking evaluation.
- [ ] Verify sample size, confidence lower bound, segment evidence, and rollback target.
- [ ] Review every pending shadow run with a real reviewer identity and decision.
- [ ] Keep candidate ranking permanently `shadow_only` until a separate explicit promotion process exists.
- [ ] Verify discovery lineage from impression to engagement to verified outcome using `GET /api/v2/ops/discovery/lineage`.
- [ ] Verify collaboration-AI provenance, retention, latency, cost, raw-content exclusion, and human override.
- [ ] Confirm no AI output can mutate payment, ledger, outcome, reputation, or settlement state.
- [ ] Run `npm run backend:advisory:ai:check` and confirm provider/model budgets, retrieval cap, retention, raw-content exclusion, and `shadow_only` status.
- [ ] Confirm every advisory-AI provider response is provenance-bound, cost/latency-bounded, human-reviewable, and non-authoritative.

### Security, platform, and smoke evidence

- [ ] Run wallet challenge/signature/session authorization tests.
- [ ] Review operator scope boundaries and administrative endpoints.
- [ ] Confirm webhook SSRF protections, delivery-time DNS revalidation, signing, bounded retry, and dead-letter handling.
- [ ] Confirm the private signing key is absent from Git, logs, payloads, and reports.
- [ ] Verify the public-key fingerprint through an independent security review.
- [ ] Run rate-limit, secret-handling, audit-log, and incident-rollback checks.
- [ ] Run the no-live-funds smoke path: discovery → engagement → payment intent → verifier-read-only status.
- [ ] Run `READY_POSTGRES_DATABASE_ISOLATED=true npm run backend:ready:postgres:check` against an explicitly isolated target and preserve `status: verified` evidence.
- [ ] Run `GET /api/v2/collaboration/health` under payment/verifier degradation and confirm collaboration remains available with `paymentStateMayBeStale: true`.
- [ ] Confirm no smoke test claims settlement before verifier-owned chain evidence.
- [ ] Verify v2 extension hooks use allowlisted events, bounded projections, signed/retryable delivery, and forbidden raw-content exclusion.

### Release artifact and approval evidence

- [ ] Run `npm run test` and record the exact test summary.
- [ ] Run `npm run lint`.
- [ ] Run migration validation through migration 017.
- [ ] Run `npm run backend:release:manifest:check` on the immutable clean commit.
- [ ] Run `DATABASE_URL="$DATABASE_URL" npm run backend:release:approval:check`.
- [ ] Confirm approval artifact `status: ready` and `eligible: true`.
- [ ] Obtain the real four-reviewer approval records.
- [ ] Inject `RELEASE_SIGNING_KEY_PEM` from the approved secret manager.
- [ ] Run `npm run backend:release:payload:check`.
- [ ] Run `npm run backend:release:payload:verify /protected/path/signed-release-payload.json`.
- [ ] Confirm detached verification returns `status: verified` and exit code `0`.
- [ ] Preserve the signed artifact, public-key fingerprint, manifest hash, approval artifact, and reviewer evidence bundle.

## 4. Four mandatory reviewer records

| Reviewer | Required decision | Required identity fields | Required evidence focus |
|---|---|---|---|
| Release operator | `approved: true` | `reviewerId`, `approvedAt`, `scope: production_release`, `rollbackAcknowledged: true` | Commit, clean worktree, Railway match, rollback, smoke test, signed artifact |
| Protocol/finance reviewer | `approved: true` | Same required fields | Chain/contract/token/decimals, verifier freshness, migration/restore, reconciliation |
| AI/data reviewer | `approved: true` | Same required fields | Baseline, sample/confidence, outcome lineage, shadow queue, provenance, rollback |
| Security reviewer | `approved: true` | Same required fields | Auth, scopes, SSRF/DNS, secrets, key custody, fingerprint, audit logs |

Use the detailed YAML/JSON form in `docs/secure-release-key-and-reviewer-signoff-template.md`. The following values are the minimum approval schema and are invalid until replaced with real evidence:

```json
{
  "approved": true,
  "reviewerId": "<real authorized reviewer identity>",
  "approvedAt": "<real ISO-8601 timestamp>",
  "scope": "production_release",
  "rollbackAcknowledged": true
}
```

## 5. Remaining engineering backlog after BD/BB

The items below are the next build sequence. They are deliberately separated from environment-controlled release blockers; code can be implemented, but production readiness still depends on real target evidence.

| Proposed batch | Scope | Priority | Exit condition |
|---|---|---:|---|
| AU | Isolated database restore runner and machine-verifiable recovery artifact | Completed locally | Disposable restore is reproducible, fingerprinted, and classified `verified`; target-environment restore remains a release gate. |
| AV | Verifier operations evidence bundle: cursor freshness, worker health, bounded scan, replay/reorg counters, and operator export | Completed locally | CLI and endpoint are implemented; current local result is blocked `not_configured` until the target RPC worker and fresh cursor exist. |
| AW | Integration contract tests for `/api/v2/ops/audit/events`, `/api/v2/ops/discovery/lineage`, release approval, and verifier status with a ready PostgreSQL fixture | Completed locally | Scope and degraded-database contracts are covered; ready-PostgreSQL route fixtures remain a follow-up test-environment task. |
| AX | Read-only on-chain token metadata probe for configured ERC-20 `decimals`, symbol, chain, and contract consistency | Completed locally | Probe and mismatch tests pass; target RPC evidence remains pending. |
| AY | Durable outbox and operator delivery health for audit/lineage/reconciliation evidence | Completed locally | Verifier API and worker projections enqueue durable events; health/event endpoints expose retry, lease, failure, and dead-letter states without financial mutation. |
| AZ | Discovery evaluation export extension using the new lineage endpoint and verified outcome labels | Completed locally | Export now includes lineage status, ranking position, outcome IDs, coverage counts, and `rawContentIncluded: false`. |
| BA | Advisory AI provider/retrieval boundary with provenance, cost, latency, and human override | Completed locally | Provider contract, content-free retrieval references, source-event provenance, retention, latency/cost budgets, human review, and no-settlement authority are enforced. |
| BB | Collaboration provider health/degraded-state surface | Completed locally | `/api/v2/collaboration/health` separates collaboration availability from payment/verifier/indexer degradation; core store/auth failures block while payment degradation does not. |
| BC | Controlled Base Sepolia smoke harness with zero-live-funds guardrails | Completed locally | Harness refuses non-isolated databases, non-Base-Sepolia policy, missing enabled token registry, and chain mutations; disposable target execution remains operator-run. |
| BD | Public API and extension contract documentation with versioning and scope matrix | Completed locally | v2 operations, lineage, verifier, recovery, token metadata, smoke, and public extension schemas are documented; BP adds the public OpenAPI document and dependency-free SDK surface. |
| BI | Ready-PostgreSQL BG/BH verification and webhook signature security | Pushed | Ready verification now creates only disposable engagement fixtures and calls BG/BH read-only paths; BF reviewer writes remain excluded. HMAC-SHA256 uses exact body binding, bounded `WEBHOOK_SIGNATURE_TOLERANCE_MS`, and replay-key protection through the shared verifier. |
| BJ | End-to-end webhook replay-load validation and shared durable-store guidance | Pushed | The isolated test delivered 100 events through captured callbacks, independently verified each signature, and rejected all 100 duplicate replay attempts. Production horizontal scaling still requires a shared atomic replay/inbox store; the in-process guard is not treated as sufficient. |
| BK | Shadow-review approval and isolated-recovery operator runbook | Implemented locally | Non-submitting `approved_pilot` templates, post-submit audit verification, isolated restore commands, and exact 17-migration evidence requirements. |
| BL | Durable idempotency expiry cleanup and shared webhook replay claims | Pushed | Expired idempotency records are removed in bounded `FOR UPDATE SKIP LOCKED` batches; migration 014 provides an atomic PostgreSQL replay barrier and signature-before-claim verifier boundary. |
| BF | Durable reviewer-decision audit records | Pushed | New and replayed human shadow-review decisions are written as operator audit evidence in the same transaction; notes are hashed rather than copied, outbox events are queued, and responses remain `shadow_only`. |
| BG | Engagement payment-state surface | Pushed | The authenticated participant can read verifier/ledger-owned lifecycle, finality, payment status, cursor freshness, and `paymentStateMayBeStale` without blocking collaboration. |
| BH | Outbox delivery processor | Pushed | Operators can dry-run or process due durable events to matching v2 hooks with SSRF-safe signed delivery, bounded retry, dead-letter evidence, and no settlement authority. |
| BE | Multi-chain expansion | Deferred | Only consider after single-chain reliability targets, reconciliation SLOs, and incident rollback evidence are met. |

The safest remaining engineering order is **validate and push BS/BT/BU → target evidence for AU/AV/AX/BC/AY/BA/BI/BL/BM/BN/BO/BP/BQ/BR → authenticated Railway target verification → verifier, outbox, and housekeeping activation**, while **BE remains intentionally deferred**.
 The user-visible product can advance through discovery, collaboration, and Base Sepolia time-to-money flows without pretending that multi-chain or autonomous AI promotion is production-ready.

## 6. Current release commands

```bash
cd /home/ubuntu/projects/PAYTRAY

git status --short
git rev-parse HEAD
npm run backend:quality:check
npm run test
npm run lint
DATABASE_URL="$DATABASE_URL" npm run backend:migrations:check
npm run backend:deployment:check
npm run backend:recovery:check
npm run backend:verifier:operations:check
npm run backend:outbox:health:check
npm run backend:idempotency:cleanup:check
npm run backend:target:operations:check
npm run backend:verifier:worker:check
npm run backend:advisory:ai:check
READY_POSTGRES_DATABASE_ISOLATED=true npm run backend:ready:postgres:check
npm run backend:token:metadata:check
npm run backend:smoke:phase2:check
npm run backend:railway:trial:check
DATABASE_URL="$DATABASE_URL" npm run backend:release:approval:check
npm run backend:release:manifest:check
npm run backend:release:payload:check
npm run backend:release:payload:verify /protected/path/signed-release-payload.json
```

The last two commands must remain blocked until real approval, Railway, migration/recovery, and signing-key evidence are available. A blocked result is the correct security outcome, not a reason to weaken the gate.

## References

[1]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/MasterBlueprint.md MasterBlueprint roadmap and architecture

[2]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/docs/final-production-release-checklist.md Final production release checklist

[3]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/docs/secure-release-key-and-reviewer-signoff-template.md Secure key and reviewer template

[4]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/packages/backend/lib/auditLogService.js Batch AR audit service

[5]: https://github.com/OxCryptobot/PAYTRAY/blob/16165d61b5f1192fb747b31ea3783b65e1e6326f/packages/backend/lib/discoveryLineageService.js Batch AT lineage service
