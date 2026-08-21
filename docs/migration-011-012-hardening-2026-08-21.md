# Migration-011/012 Hardening Report — 2026-08-21

## Scope

This batch adds dedicated disposable PostgreSQL contract verifiers for migration 011 payment-stream verifier provenance and migration 012 explicit human review of AI shadow-evaluation runs. Migration 021/022 were not invented because the repository has no approved SQL, runtime, or data contract for them.

## Migration 011 evidence

`verify-migration-011-payment-provenance.mjs` verifies the exact `payment_streams.last_verified_event` column contract: `jsonb`, `NOT NULL`, and default `'{}'::jsonb`. It verifies an explicit null insert is rejected with SQLSTATE `23502`, a default object is returned for a new payment stream, and an opaque JSON provenance object round-trips without mutation. It cleans two disposable user fixtures and one stream fixture.

The final local run used a fresh database named `paytray_migration_011_012_ci` on `127.0.0.1`, with `MIGRATION_011_CONTRACT_ISOLATED=true`. Result: `status=verified`, catalog passed, null negative passed with `23502`, round trip passed, `cleanupPerformed=true`, `releaseEligible=false`, `settlementAuthority=false`, `mutation=read_only`.

## Migration 012 evidence

`verify-migration-012-shadow-run-review.mjs` verifies the three migration columns (`reviewer_id`, `reviewer_notes`, `reviewed_at`) and the `ai_evaluation_runs_review_index`. It inserts one disposable `status=shadow`, `reviewer_decision=pending` run and invokes the real `reviewShadowRun` service concurrently with two conflicting decisions.

The final race produced exactly one committed review, one conflicting review, one confirmed rollback, one persisted reviewer decision, one financial-audit event, and one durable outbox event. The persisted row remained `status=shadow`; the report retained `applied=false`, `promotionStatus=shadow_only`, and `authority=human_review_required`. Review notes were not emitted. The run and all derived audit/outbox records were deleted in a finally-path cleanup.

## Validation

- Focused tests: 3 files, 20 tests passed (`recoveryArtifactTiming`, `shadowReviewService`, `shadowQualityGate`)
- Migration-011 contract: verified
- Migration-012 contract: verified
- ESLint: clean for changed code and tests
- Workflow YAML: valid, 8 jobs
- `git diff --check`: passed
- Database: local disposable PostgreSQL only

## CI and recovery wiring

The isolated PostgreSQL job now runs migration-011 and migration-012 before the later migration contracts. The restored recovery job repeats both verifiers against the restored database. Their redacted reports are included in the SHA-256 sidecar, recovery artifact bundle verification, allowlist dispatch, and retained artifact upload.

## Safety interpretation

This is engineering evidence only. The batch does not verify chain truth, payment settlement, AI promotion, genuine human approval, target readiness, release eligibility, production capacity, or settlement authority. No human identities, decisions, signing keys, approval tokens, Railway settings, target evidence, live funds, or mainnet transactions were used or fabricated.
