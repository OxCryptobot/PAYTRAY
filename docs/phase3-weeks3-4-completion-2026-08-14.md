# PayTray Phase 3 Weeks 3–4 Evaluation Pipeline

**Status:** Implemented and executed in shadow-only mode  
**Dataset version:** `phase3-ranking-v1`  
**Baseline:** `weighted-explainable-v1`

## Delivered

| Capability | Result |
|---|---|
| Evaluation export contract | `docs/phase3-evaluation-export-contract.md` defines verified labels, temporal splits, point-in-time boundaries, provenance, exclusions, and promotion gates. |
| Durable impression source | Migration `007_discovery_impressions.sql` stores query ID, candidate profile, baseline rank/score, ranking version, query features, match explanation, selection, observation time, and provenance. |
| Impression capture | `recordDiscoveryImpressions` is called by `/api/v2/discovery/experts`, creating replay-safe upserts for ranking evaluation coverage. |
| Versioned export | `exportRankingEvaluation` reads impressions plus verified engagement outcome events, creates canonical evaluation examples, and keeps missing/unverified evidence in the shadow split rather than inventing negative labels. |
| Shadow comparison | `compareRankingShadow` reports precision@k, recall@k, nDCG@k, deltas, query coverage, and `promotionStatus: shadow_only` against the Phase 2 baseline. |
| Durable evaluation records | `persistRankingShadowComparison` saves a pending evaluation run and per-profile shadow decisions with `applied: false` and `humanReviewStatus: not_reviewed`. |
| Reproducible CLI | `node packages/backend/scripts/export-ranking-evaluation.mjs` supports explicit dataset version and temporal boundaries through environment variables. |

## Sandbox execution evidence

The CLI executed successfully against PostgreSQL with dataset version `phase3-ranking-v1` and an explicit as-of boundary. It exported **0 examples** and therefore compared **0 eligible queries**, because the current sandbox database contains no discovery-impression records with verified outcome evidence. It still persisted a shadow evaluation run with `promotionStatus: shadow_only`, `applied: false`, and zero shadow decisions.

The zero-example result is an honest data-availability signal, not a synthetic benchmark. No simulated ranking quality claim is made. The next data task is to populate discovery impressions through the v2 discovery route and attach verified outcome events from real testnet/session evidence before interpreting metrics.

## Validation

The full backend suite passes **15 test files and 106 tests**. Linting, diff validation, PostgreSQL migration verification through migration `007_discovery_impressions`, and the reproducible export CLI all pass.

## Promotion gates

The Phase 2 weighted ranker remains the only active baseline. No candidate model is trained, promoted, applied to user-visible ranking, or permitted to influence payment, ledger, withdrawal, reputation, or dispute state. Promotion requires non-empty verified time-split data, baseline comparison, subgroup review where applicable, model/input/version provenance, latency and cost bounds, human approval, and a rollback target.
