# PayTray Remaining Build and Release Checklist

**Project:** PayTray — AI-enabled time-to-money platform connecting expert discovery, real-time collaboration, and ERC-20 payment streams.

**Branch:** `paytray/batch-delivery`

**Current pushed commit:** `5470dc1ab2ec6fd4506bb5afa4e701e953194b9e`

**Safety boundary:** Base Sepolia (`84532`) remains the safe settlement default. The verifier and ledger remain the economic authority. AI remains `shadow_only`. No live funds, mainnet transaction, production deployment, real user-data migration, fabricated approval, or fabricated signing key is authorized by this checklist.

## 1. Current delivery state

The latest multi-phase tranche is validated and pushed to the remote branch. It adds reproducible recovery evidence, verifier-operations evidence, route-level degraded-database contracts, read-only ERC-20 metadata validation, lineage-backed evaluation export, controlled Base Sepolia smoke guardrails, and versioned API documentation on top of the pushed AR–AT capabilities.

| Batch | Capability | State | Evidence |
|---|---|---|---|
| AP | Ed25519 canonical release payload construction | Pushed | `19a78e0a5bf53ea9e63f70af74b470a8e330d06e` |
| AQ | Detached signed-payload verification and tamper rejection | Pushed | `c447a5218bb221deac08df4b490ac56dbe27ff8e` |
| AR | Read-only paginated/filterable financial audit events with metadata redaction | Pushed | `packages/backend/lib/auditLogService.js`; `GET /api/v2/ops/audit/events` |
| AS | Production chain/protocol/token-registry consistency validation | Pushed | `packages/backend/lib/payments/tokenRegistry.js`; deployment preflight |
| AT | Discovery impression → engagement → outcome lineage | Pushed | `packages/backend/lib/discoveryLineageService.js`; `GET /api/v2/ops/discovery/lineage` |
| AU | Isolated PostgreSQL recovery evidence with backup fingerprint and restore verification | Pushed | `packages/backend/scripts/verify-recovery-evidence.mjs`; disposable restore returned `verified` |
| AV | Verifier operations evidence CLI and scoped operator endpoint | Pushed | `packages/backend/lib/verifierOperationsEvidence.js`; `GET /api/v2/ops/verifier/operations` |
| AW | Route-level degraded-database and scope integration contracts | Pushed | `packages/backend/tests/api.test.js`; 3 operator evidence routes fail closed |
| AX | Read-only ERC-20 symbol/decimals/chain metadata probe | Pushed | `packages/backend/lib/payments/tokenMetadataProbe.js` |
| AZ | Lineage-backed evaluation export coverage | Pushed | `packages/backend/lib/evaluationExport.js` |
| BC | Controlled Base Sepolia smoke harness with disposable-data and no-chain-mutation guards | Pushed | `packages/backend/scripts/verify-phase2-loop.mjs` |
| BD | Versioned v2 operations and lineage API documentation | Pushed | `docs/api/v2-operations-and-lineage-contracts.md` |

The latest validation passed **41 test files and 181 tests**, including AU–BD focused coverage, ESLint, migrations through 013, a disposable isolated PostgreSQL backup/restore returning `verified`, and `git diff --check`. The release manifest is ready and read-only. The production release approval and signed payload remain blocked by genuine environment and human-evidence requirements.

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

### Security, platform, and smoke evidence

- [ ] Run wallet challenge/signature/session authorization tests.
- [ ] Review operator scope boundaries and administrative endpoints.
- [ ] Confirm webhook SSRF protections, delivery-time DNS revalidation, signing, bounded retry, and dead-letter handling.
- [ ] Confirm the private signing key is absent from Git, logs, payloads, and reports.
- [ ] Verify the public-key fingerprint through an independent security review.
- [ ] Run rate-limit, secret-handling, audit-log, and incident-rollback checks.
- [ ] Run the no-live-funds smoke path: discovery → engagement → payment intent → verifier-read-only status.
- [ ] Confirm no smoke test claims settlement before verifier-owned chain evidence.

### Release artifact and approval evidence

- [ ] Run `npm run test` and record the exact test summary.
- [ ] Run `npm run lint`.
- [ ] Run migration validation through migration 013.
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

## 5. Remaining engineering backlog after AT

The items below are the next build sequence. They are deliberately separated from environment-controlled release blockers; code can be implemented, but production readiness still depends on real target evidence.

| Proposed batch | Scope | Priority | Exit condition |
|---|---|---:|---|
| AU | Isolated database restore runner and machine-verifiable recovery artifact | Completed locally | Disposable restore is reproducible, fingerprinted, and classified `verified`; target-environment restore remains a release gate. |
| AV | Verifier operations evidence bundle: cursor freshness, worker health, bounded scan, replay/reorg counters, and operator export | Completed locally | CLI and endpoint are implemented; current local result is blocked `not_configured` until the target RPC worker and fresh cursor exist. |
| AW | Integration contract tests for `/api/v2/ops/audit/events`, `/api/v2/ops/discovery/lineage`, release approval, and verifier status with a ready PostgreSQL fixture | Completed locally | Scope and degraded-database contracts are covered; ready-PostgreSQL route fixtures remain a follow-up test-environment task. |
| AX | Read-only on-chain token metadata probe for configured ERC-20 `decimals`, symbol, chain, and contract consistency | Completed locally | Probe and mismatch tests pass; target RPC evidence remains pending. |
| AY | Durable outbox and operator delivery health for audit/lineage/reconciliation evidence | P1 | Operational events are retry-safe, observable, and dead-lettered without affecting financial authority. |
| AZ | Discovery evaluation export extension using the new lineage endpoint and verified outcome labels | Completed locally | Export now includes lineage status, ranking position, outcome IDs, coverage counts, and `rawContentIncluded: false`. |
| BA | Advisory AI provider/retrieval boundary with provenance, cost, latency, and human override | P1 | AI assistance is measurable and bounded; no model output has settlement authority. |
| BB | Collaboration provider health/degraded-state surface | P1 | Chat/call UX remains responsive when payment RPC, verifier, or indexer is degraded. |
| BC | Controlled Base Sepolia smoke harness with zero-live-funds guardrails | Completed locally | Harness refuses non-isolated databases, non-Base-Sepolia policy, missing enabled token registry, and chain mutations; disposable target execution remains operator-run. |
| BD | Public API and extension contract documentation with versioning and scope matrix | Completed locally | v2 operations, lineage, verifier, recovery, token metadata, and smoke contracts are documented; broader public extension schema work remains. |
| BE | Multi-chain expansion | Deferred | Only consider after single-chain reliability targets, reconciliation SLOs, and incident rollback evidence are met. |

The safest remaining engineering order is **ready-target evidence for AU/AV/AX/BC → ready-PostgreSQL AW fixtures → AY outbox health → BA provider/retrieval boundaries → BB collaboration health → broader BD public extension schemas**, while **BE remains intentionally deferred**. The user-visible product can advance through discovery, collaboration, and Base Sepolia time-to-money flows without pretending that multi-chain or autonomous AI promotion is production-ready.

## 6. Current release commands

```bash
cd /home/ubuntu/projects/PAYTRAY

git status --short
git rev-parse HEAD
npm run test
npm run lint
DATABASE_URL="$DATABASE_URL" npm run backend:migrations:check
npm run backend:deployment:check
npm run backend:recovery:check
npm run backend:verifier:operations:check
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
