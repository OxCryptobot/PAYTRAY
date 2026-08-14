# PayTray Phase 3 Weeks 1–2 Foundation

**Status:** Complete as a data and evaluation foundation; no AI model is production-authoritative

## Delivered

| Foundation | Result |
|---|---|
| Data and trust policy | `docs/phase3-ai-data-contract.md` defines verified evidence, unverified participant reports, point-in-time rules, privacy classes, retention, model provenance, human review, and rollback policy. |
| Durable AI schema | Migration `006_ai_evaluation_foundation.sql` adds `ai_feature_snapshots`, `ai_evaluation_examples`, `ai_evaluation_runs`, and `ai_shadow_decisions`. |
| Feature boundary | `createFeatureSnapshot` records version, as-of time, source IDs, deterministic source hash, privacy class, and retention deadline while rejecting raw message/call/private-key content. |
| Evaluation boundary | `createEvaluationExample` rejects unverified labels outside shadow split and requires dataset version, time, source IDs, verification status, and provenance. |
| Shadow mode | `createShadowDecision` records model/input/output provenance, confidence, reason codes, human review state, and `applied: false`. The persistence command hardcodes unapplied/not-reviewed state. |
| Baseline metrics | Deterministic precision@k, recall@k, nDCG@k, per-query results, and averaged ranking metrics are implemented for baseline comparison. |
| Durable repositories | Parameterized persistence commands exist for feature snapshots, evaluation examples, evaluation runs, and shadow decisions. |

## Validation

The backend suite passes **12 test files and 98 tests**. Linting and `git diff --check` pass. The PostgreSQL migration verification passes with the full schema through migration `006_ai_evaluation_foundation`, including all AI foundation tables and existing financial/discovery tables.

## Non-authoritative by design

This tranche does not train or activate a model, change discovery ordering in production, summarize private conversations, alter payment state, freeze funds, deny withdrawals, or update reputation. The Phase 2 weighted ranker remains the rollback baseline. The next Phase 3 work can build a verified dataset export and run ranking models in shadow mode, but promotion requires time-split evaluation, subgroup checks, provenance, cost/latency limits, human review, and a rollback target.

## Next runnable step

Create a versioned evaluation export from verified `engagement_outcome_events`, `payment_chain_events`, `ledger_entries`, and durable engagement records. Exclude unverified participant reports from train/test labels; retain them only in the shadow split for data-quality analysis.
