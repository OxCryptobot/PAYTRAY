# Shadow-Review and Isolated-Recovery Operator Runbook

## Safety boundary

This document contains **templates only**. It does not contain an access token, reviewer identity, approval evidence, database URL, signing key, or real reviewer notes. Do not submit any `approved_pilot` decision until an authorized human reviewer has independently inspected the corresponding run and recorded a genuine decision. Never execute the six approval requests as an unattended loop.

All first-release payment validation remains on Base Sepolia (`84532`) with mainnet disabled. Shadow-review decisions do not promote AI or change payment, ledger, dispute, reputation, or settlement state.

## 1. Operator authentication and queue inspection

The review routes require a valid PayTray access token with `ops:*`. The server binds `reviewerId` to the authenticated wallet address; the JSON body cannot choose the reviewer identity.

Set placeholders in a protected shell environment without printing them:

```bash
export PAYTRAY_BASE_URL='https://<authorized-paytray-target>'
export OPS_ACCESS_TOKEN='<real-operator-access-token>'
```

### 1.1 Read-only health and evidence preflight

Before reviewing or submitting any shadow decision, capture the current operator state from the same authenticated target. The dashboard is diagnostic only; it does not approve reviews, start workers, process the outbox, or grant release or settlement authority.

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/health/dashboard" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" \
  -o /protected/evidence/paytray-health-dashboard-<COMMIT>.json

curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/evidence" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" \
  -o /protected/evidence/paytray-unified-evidence-<COMMIT>.json
```

A `503` response is expected while verifier freshness, reconciliation, Railway, recovery, shadow-review, sign-off, or signing-key evidence is incomplete. Preserve the response body rather than retrying until it appears healthy. Confirm the dashboard contains `authority: "operator_health_aggregation_only"`, `releaseEligible: false`, `settlementAuthority: false`, `mutation: "read_only"`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`.

Create and independently verify the canonical evidence bundle before preserving the release evidence package:

```bash
DATABASE_URL="$DATABASE_URL" npm run backend:ops:evidence:bundle:check \
  > /protected/evidence/paytray-evidence-bundle-<COMMIT>.json

npm run backend:ops:evidence:bundle:verify \
  /protected/evidence/paytray-evidence-bundle-<COMMIT>.json
```

The bundle generator may exit `1` while real release evidence is incomplete; preserve that blocked artifact and require the verifier command to return `status: "verified"` before treating the file as integrity-verified. Integrity verification proves only that the saved bundle is internally consistent. It does not prove release readiness, approve reviewers, or grant settlement authority.

Run the local or CI matrix before target-specific checks:

```bash
npm run backend:operations:quality:check
```

In normal mode, `status: "operator_blocked"` with `unexpectedFailureCount: 0` is an honest result when target evidence is unavailable. Do not set strict mode on a development target. In a fully configured release environment only, the authorized operator may run:

```bash
OPERATIONS_QUALITY_STRICT=true npm run backend:operations:quality:check
```

Strict mode must fail until all required operator evidence is real. Neither mode changes `releaseEligible`, `settlementAuthority`, payment state, ledger state, reviewer decisions, or AI promotion status.

For post-run inspection, first list the bounded audit summaries and then retrieve one valid run by its returned UUID:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/operations-quality/runs?limit=20" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"

curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/operations-quality/runs/<RUN_UUID>" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

The detail response contains only the persisted redacted report and canonical hash. A missing UUID returns `404`; a malformed identifier must be rejected before database lookup. Neither endpoint changes payment state, reviewer decisions, AI promotion, release eligibility, or settlement authority.

List pending runs before reviewing them:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs?status=pending&limit=100" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

Inspect each run before making a decision:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/<RUN_ID>" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

The reviewer must examine baseline and candidate metrics, sample count, confidence lower bound, model and dataset versions, segment evidence, limitations, and rollback target. The quality gate expects sample count at least 30, candidate nDCG improvement of at least 0.01, nonnegative improvement confidence lower bound, and both a baseline version and rollback target. These are review inputs, not an automatic approval rule.

## 2. Exact approved-pilot payload template

The only accepted approval decision value is `approved_pilot`. The notes must be written by the real reviewer and should explain the evidence reviewed, limitations, rollback target, and why the reviewer is approving a pilot while preserving `shadow_only` authority. Do not place secrets, private keys, credentials, or unnecessary personal data in notes.

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/<RUN_ID>/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "decision": "approved_pilot",
  "notes": "<REAL_REVIEWER_NOTES: evidence reviewed, sample/confidence result, baseline and candidate context, limitations, rollback target, and pilot scope>"
}
JSON
```

The server binds the reviewer identifier from the authenticated wallet and starts a PostgreSQL transaction. The service locks the evaluation run, accepts only `approved_pilot` or `rejected`, rejects non-shadow runs, rejects conflicting terminal decisions, records the reviewer decision, writes a privacy-preserving financial audit event, and queues the matching outbox event in the same transaction.

The response must continue to contain these safety invariants:

```json
{
  "applied": false,
  "promotionStatus": "shadow_only",
  "authority": "human_review_required"
}
```

## 3. Six manual submission templates

Use the same payload template above, one run at a time, only after a real reviewer has inspected that run. The following identifiers are the known pending runs. Replace `<REAL_REVIEWER_NOTES...>` with the reviewer’s actual evidence-backed notes; do not submit the placeholder text.

```bash
# 1. d9280263-932b-45b0-a173-ed3e7e2dcb3c
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/d9280263-932b-45b0-a173-ed3e7e2dcb3c/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_1>"}'

# 2. 5d85ded6-4842-4091-85f3-8046e90c7b79
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/5d85ded6-4842-4091-85f3-8046e90c7b79/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_2>"}'

# 3. eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_3>"}'

# 4. 3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_4>"}'

# 5. c25b2bee-4fac-4f87-acf3-00541a093030
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/c25b2bee-4fac-4f87-acf3-00541a093030/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_5>"}'

# 6. 7b0f934d-8bda-4b10-aa4c-d7fc019078e4
curl --fail-with-body --silent --show-error -X POST \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/7b0f934d-8bda-4b10-aa4c-d7fc019078e4/review" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"decision":"approved_pilot","notes":"<REAL_REVIEWER_NOTES_FOR_RUN_6>"}'
```

These commands are intentionally not executed by this runbook. A reviewer may instead submit `{"decision":"rejected", ...}` when the evidence does not support an approved pilot. A repeated identical terminal decision is recorded as an idempotent replay; a conflicting decision is rejected.

## 4. Post-submit verification for each real decision

Inspect the run and confirm the response remains shadow-only:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs/<RUN_ID>" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

Inspect redacted durable audit evidence:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/audit/events?actorType=operator&action=shadow_review_recorded&entityType=ai_evaluation_run&entityId=<RUN_ID>&limit=100" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

Inspect the matching durable outbox evidence without requesting payload bodies:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/outbox/events?status=pending&limit=100" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

Confirm the pending queue is empty only after every run has a genuine durable decision:

```bash
curl --fail-with-body --silent --show-error \
  "${PAYTRAY_BASE_URL}/api/v2/ops/shadow-runs?status=pending&limit=100" \
  -H "Authorization: Bearer ${OPS_ACCESS_TOKEN}"
```

A zero pending count is necessary but does not promote a model and does not clear Railway, recovery, verifier, reconciliation, human sign-off, or Ed25519 signing-key gates.

## 5. Recovery and isolated 13-migration verification

The recovery script creates a fresh source backup, so `RECOVERY_BACKUP_FILE` must point to a protected path. It uses `pg_dump --format=custom --no-owner --no-privileges`, sets backup mode `0600`, calculates SHA-256, and runs `pg_restore --list` for catalog evidence.

First, run backup/catalog evidence only when an isolated restore target is not yet available:

```bash
DATABASE_URL='<SOURCE_DATABASE_URL_FROM_SECRET_MANAGER>' \
RECOVERY_BACKUP_FILE='/protected/evidence/paytray-<COMMIT>.dump' \
npm run backend:recovery:check
```

This produces `status: schema_catalog_only` and exit code 1 when no restore URL is supplied. That is not sufficient for the target release gate.

For the gate-clearing path, provide a **different** isolated target and explicit isolation acknowledgement:

```bash
DATABASE_URL='<SOURCE_DATABASE_URL_FROM_SECRET_MANAGER>' \
RECOVERY_BACKUP_FILE='/protected/evidence/paytray-<COMMIT>.dump' \
RECOVERY_RESTORE_DATABASE_URL='<ISOLATED_RESTORE_DATABASE_URL>' \
RECOVERY_TARGET_ISOLATED=true \
npm run backend:recovery:check
```

The script rejects a restore when the source and restore URLs are identical or when `RECOVERY_TARGET_ISOLATED` is not exactly `true`. It restores with `pg_restore --exit-on-error --no-owner --no-privileges`, then checks all expected public tables and requires exactly 18 rows in `schema_migrations`. A successful result has `status: verified`, `restore.status: verified`, `restore.migrationCount: 18`, `deploymentPerformed: false`, and `settlementMutationPerformed: false`.

The recovery script’s count check should be followed by the stricter migration/schema verifier against the isolated target:

```bash
DATABASE_URL='<ISOLATED_RESTORE_DATABASE_URL>' \
npm run backend:migrations:check
```

That command checks the exact migration names:

```text
001_init
002_financial_core
003_discovery_v1
004_engagement_context
005_outcomes_and_metrics
006_ai_evaluation_foundation
007_discovery_impressions
008_production_telemetry
009_verified_outcome_provenance
010_ledger_intent_idempotency
011_payment_stream_verifier_provenance
012_shadow_run_review
013_verifier_cursors
014_webhook_replay_claims
015_verified_trust_signals
016_webhook_inbox
017_extension_hooks
018_operations_quality_runs
```

It also checks the required table set, `payment_verifier_cursors`, shadow-review columns, verifier provenance columns, outcome-verification columns, payment lifecycle columns, discovery columns, and the unique ledger index. Preserve the backup SHA-256, catalog listing, isolated restore log, migration output, and application connectivity result together as the recovery evidence bundle.

No command in this runbook deploys, submits a chain transaction, moves funds, approves a reviewer decision, or fabricates signing evidence.
