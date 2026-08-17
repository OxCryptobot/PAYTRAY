# PayTray Shadow-Review Submission and Four-Signoff Runbook

**Purpose:** Provide a human-operated, fail-closed workflow for recording decisions on the six pending AI ranking shadow runs and verifying the four distinct release sign-off roles. This runbook does not generate decisions, reviewer identities, signing keys, approval tokens, or release authority.

## Safety boundary

PayTray remains an AI-enabled time-to-money platform. Candidate ranking is `shadow_only`; verifier-owned chain evidence remains the economic truth; and human review is required before any pilot decision is considered. The submission runner defaults to `dry_run`, rejects incomplete or placeholder worksheets, refuses sensitive fields, requires all six known run IDs, and requires explicit confirmation before network submission.

> Never submit a decision unless an authorized human has independently reviewed the run evidence and supplied the decision, rationale, evidence reference, and rollback target. Do not auto-approve the six pending runs.

## 1. Prepare a real reviewer worksheet

Create a local file outside the repository, for example `/secure/paytray/shadow-review-decisions.json`, with this shape. Replace every value with real reviewer-supplied evidence; do not copy these placeholders into a submission file.

```json
{
  "releaseCommit": "<40-character lowercase release commit>",
  "reviews": [
    {
      "runId": "d9280263-932b-45b0-a173-ed3e7e2dcb3c",
      "decision": "approved_pilot",
      "notes": "<real evidence-backed rationale of at least 20 characters>",
      "evidenceReviewed": "<candidate, baseline, sample, confidence, segments, limitations>",
      "rollbackTarget": "<real rollback target>"
    }
  ]
}
```

The `reviews` array must contain exactly these six IDs, each once:

```text
d9280263-932b-45b0-a173-ed3e7e2dcb3c
5d85ded6-4842-4091-85f3-8046e90c7b79
eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49
3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a
c25b2bee-4fac-4f87-acf3-00541a093030
7b0f934d-8bda-4b10-aa4c-d7fc019078e4
```

A decision must be either `approved_pilot` or `rejected`. The runner never fills in a decision. Notes must explain the evidence actually reviewed, and the rollback target must be the real documented baseline or rollback artifact.

## 2. Run the mandatory dry run first

The command validates the worksheet and performs no network request:

```bash
export PAYTRAY_REVIEW_WORKSHEET_FILE=/secure/paytray/shadow-review-decisions.json
export SHADOW_REVIEW_SUBMISSION_MODE=dry_run
npm run backend:release:shadow:reviews:submit:check
```

Expected safe output includes:

```json
{
  "status": "dry_run",
  "expectedRunCount": 6,
  "suppliedRunCount": 6,
  "networkRequestsPerformed": false,
  "submissionPerformed": false,
  "applied": false,
  "promotionStatus": "shadow_only",
  "authority": "human_review_required",
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only"
}
```

If the worksheet is incomplete, contains placeholders, includes sensitive fields, or has duplicate/missing run IDs, the command returns `status: blocked` and exits nonzero. Do not bypass that result.

## 3. Submit only after human authorization

Submission is intentionally guarded by explicit environment values. The operator must supply the real authenticated session token through an approved secret mechanism; never place it in a file, shell history, worksheet, log, or chat transcript.

```bash
export PAYTRAY_REVIEW_BASE_URL=https://<authenticated-paytray-target>
export PAYTRAY_REVIEW_ACCESS_TOKEN='<inject ephemerally; do not persist or print>'
export PAYTRAY_REVIEW_WORKSHEET_FILE=/secure/paytray/shadow-review-decisions.json
export PAYTRAY_REVIEW_EXPECTED_COMMIT=<same 40-character lowercase commit as worksheet.releaseCommit>
export SHADOW_REVIEW_SUBMISSION_MODE=submit
export SHADOW_REVIEW_SUBMISSION_ENABLED=true
export SHADOW_REVIEW_SUBMISSION_CONFIRMATION=I_UNDERSTAND_HUMAN_REVIEW_SUBMISSION
```

If any decision is `approved_pilot`, add the second explicit confirmation only after the responsible AI/data reviewer has approved that specific decision:

```bash
export SHADOW_REVIEW_APPROVED_PILOT_CONFIRMATION=I_UNDERSTAND_APPROVED_PILOT_DECISION
```

Then execute:

```bash
npm run backend:release:shadow:reviews:submit:check
```

The runner submits sequentially to the repository route:

```text
POST /api/v2/ops/shadow-runs/:runId/review
```

The request body contains only the human-supplied `decision` and `notes`. Authentication supplies the reviewer wallet. The runner refuses a response unless it confirms `applied=false`, `promotionStatus=shadow_only`, and `authority=human_review_required`. A successful submission is not a release approval and does not change settlement authority.

## 4. Verify all six decisions after submission

Use the authenticated read-only status route or repository command:

```bash
export DATABASE_URL=postgresql://<redacted-disposable-or-authorized-target>
npm run backend:shadow:reviews:check
```

For each run, confirm the following fields from the read-only snapshot:

```text
status: shadow
reviewerDecision: approved_pilot or rejected
reviewerAssigned: true
reviewedAt: non-null ISO-8601 timestamp
```

Also confirm that no run reports an applied decision, ranking promotion, settlement authority, or payment mutation. Inspect the financial audit and outbox records through their read-only operator surfaces; reviewer notes must remain hashed or excluded from financial metadata and raw collaboration content must not be exposed.

## 5. Verify the four cryptographic reviewer attestations

The release commit must have one verified attestation for each role:

```text
release_operator
protocol_finance
ai_data
security
```

For each reviewer, the authenticated operator calls the challenge route with the exact release commit, release-artifact SHA-256, public-key fingerprint SHA-256, role, and human decision:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$PAYTRAY_REVIEW_BASE_URL/api/v2/ops/reviewer-attestations/challenge" \
  -H "Authorization: Bearer $PAYTRAY_REVIEW_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @/secure/paytray/<role>-challenge-request.json
```

The challenge request must contain only real values:

```json
{
  "role": "security",
  "releaseCommit": "<40-character lowercase commit>",
  "artifactSha256": "<64-character lowercase artifact hash>",
  "publicKeyFingerprintSha256": "<64-character lowercase Ed25519 public-key fingerprint>",
  "decision": "approved",
  "ttlSeconds": 900
}
```

The response supplies the exact canonical EIP-191 message. The reviewer signs that exact message with the wallet associated with the authenticated session. Do not reconstruct, normalize, trim, or edit the message. Verify the challenge response returns `challenge_issued`, a 40-character release commit, the exact artifact hash, the exact public-key fingerprint, and `releaseEligible=false`.

Submit the signature through the verification route:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$PAYTRAY_REVIEW_BASE_URL/api/v2/ops/reviewer-attestations/verify" \
  -H "Authorization: Bearer $PAYTRAY_REVIEW_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @/secure/paytray/<role>-attestation.json
```

The verification request body is:

```json
{
  "challengeId": "<challenge ID returned by the server>",
  "signature": "<65-byte EIP-191 signature returned by the wallet>"
}
```

The server derives `authenticatedWallet` from the authenticated session; it is not a client-supplied body field.

The server requires a 65-byte signature, checks the challenge expiry and one-time consumption, recomputes the message hash, recovers the signing wallet, and binds the attestation to the challenge role, commit, artifact hash, key fingerprint, and decision. Never reuse a challenge or expose signature bytes in evidence artifacts.

Inspect the four attestations read-only:

```bash
curl --fail-with-body --silent --show-error \
  -G "$PAYTRAY_REVIEW_BASE_URL/api/v2/ops/reviewer-attestations" \
  -H "Authorization: Bearer $PAYTRAY_REVIEW_ACCESS_TOKEN" \
  --data-urlencode "releaseCommit=<40-character lowercase commit>"
```

Every record must have `decision=approved`, the exact release commit, the exact artifact hash, the exact key fingerprint, `applied=false`, `release_eligible=false`, `settlement_authority=false`, and `mutation=read_only`. The four roles must be unique; migration 019 enforces uniqueness on `(release_commit, role)`.

## 6. Verify the four human sign-off gates

The four sign-off roles are distinct and cannot be represented by one person or one generic approval:

| Role | Required review focus | Required evidence |
|---|---|---|
| `release_operator` | Exact release commit, manifest, clean worktree, deployment boundary, rollback procedure | Real identity, approved decision, timestamp, `production_release` scope, rollback acknowledgement, evidence reference, rollback target |
| `protocol_finance` | Base Sepolia policy, Sablier Flow v3 configuration, token registry, ledger/reconciliation, recovery evidence | Same exact artifact binding plus finance/protocol evidence and rollback acknowledgement |
| `ai_data` | Six shadow-run decisions, candidate-vs-baseline evidence, dataset lineage, confidence, limitations, rollback target | Same exact artifact binding plus evidence-backed AI/data notes |
| `security` | Ed25519 key custody, public-key fingerprint, secret-manager injection, threat controls, redaction | Same exact artifact binding plus independent fingerprint and custody verification |

For each role, verify the worksheet record contains a real reviewer identity, a valid timestamp, `approved=true`, `scope=production_release`, `rollbackAcknowledged=true`, `evidenceReviewed`, `rollbackTarget`, and non-placeholder notes. Verify the four roles are distinct and all reference the same immutable commit and artifact hash.

Run the repository evidence checks only after the real records exist:

```bash
DATABASE_URL="$DATABASE_URL" npm run backend:release:evidence:check
DATABASE_URL="$DATABASE_URL" npm run backend:release:approval:check
DATABASE_URL="$DATABASE_URL" npm run backend:release:gates:check
DATABASE_URL="$DATABASE_URL" npm run backend:release:manifest:check
```

The expected pre-approval state remains blocked. Release becomes eligible only if the composed evidence service reports all required gates ready, the four verified reviewer attestations are complete for the exact commit, all six shadow reviews are terminal with genuine evidence, target/recovery/verifier evidence is fresh, and real operator key custody is independently verified. Code must not override a blocked result.

## 7. Post-submit safety audit

After any authorized submission, independently confirm that no record changed `applied` to true, no candidate ranker moved out of `shadow_only`, no payment or ledger state changed, no reviewer notes were copied into raw financial metadata, no private key or signature bytes were emitted, and no deployment or settlement mutation occurred. Preserve the redacted reports and SHA-256 sidecars as evidence, but do not upload access tokens, raw signatures, notes, raw collaboration content, or user data.
