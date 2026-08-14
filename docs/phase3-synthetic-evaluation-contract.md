# PayTray Synthetic Evaluation Harness Contract

**Purpose:** Exercise the versioned evaluation export and shadow comparison pipeline with deterministic mock evidence.

## Isolation boundary

Synthetic fixtures are test-only and must not be inserted into the shared PostgreSQL database, production tables, user-visible ranking paths, payment tables, ledger tables, reputation records, or Git history. The harness uses an in-memory query adapter and writes only a local JSON report under `docs/evidence/`.

## Fixture coverage

| Fixture | Purpose | Expected handling |
|---|---|---|
| Query A / Provider Alpha | High baseline score with verified completion and repeat booking | Eligible validation label with high relevance. |
| Query A / Provider Beta | Medium baseline score with verified completion | Eligible validation label with lower relevance. |
| Query A / Provider Gamma | Lower baseline score with no verified evidence | Shadow-only example; no invented negative label. |
| Query B / Provider Delta | Highest baseline score but verified dispute | Eligible negative trust label. |
| Query B / Provider Epsilon | Lower baseline score with verified completion | Eligible positive label, useful for measuring baseline miss. |
| Participant report | Unverified completion-like event | Shadow-only and excluded from train/validation/test. |

## Expected assertions

The report must contain a non-empty verified evaluation set, a non-empty shadow set, deterministic temporal splits, baseline metrics, candidate metrics, metric deltas, per-query rankings, and `promotionStatus: shadow_only`. Every synthetic decision must remain `applied: false`. The result must state that mock metrics are pipeline-validation evidence only and cannot support a product-quality or model-promotion claim.
