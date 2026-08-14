# PayTray Synthetic Ranking Evaluation Results

**Source:** `synthetic_mock_fixture`  
**Dataset:** `phase3-ranking-synthetic-v1`  
**Status:** Pipeline validation only; not production ranking evidence

## Fixture and evidence handling

The harness processed **7 synthetic discovery impression rows** across 3 queries. Five rows had verified outcome evidence and entered the eligible comparison set. Two rows remained shadow-only, including one row with an unverified participant-like event. The unverified event was ignored for eligible labels rather than converted into a negative training signal.

## Baseline versus candidate

| Metric | Phase 2 weighted baseline | Deterministic mock candidate | Delta |
|---|---:|---:|---:|
| Query count | 3 | 3 | 0 |
| Precision@3 | 0.833333 | 0.833333 | 0 |
| Recall@3 | 1.000000 | 1.000000 | 0 |
| nDCG@3 | 0.876977 | 1.000000 | +0.123023 |

The mock candidate sorts by the synthetic relevance map. Its nDCG improvement confirms that the comparison pipeline detects a controlled ranking change; it does **not** demonstrate that a real model improves PayTray discovery quality.

## Shadow safety

The run persisted evaluation run `synthetic-run-1` and **5 shadow decisions**. All decisions remained `promotionStatus: shadow_only` and `applied: false`. The harness made 14 parameterized persistence calls through the repository boundary and did not connect to PostgreSQL or alter product data.

## Interpretation limits

These fixtures are intentionally small, deterministic, and synthetic. They do not represent users, real profiles, real payment events, or real engagement outcomes. They cannot establish model quality, fairness, willingness to pay, or production readiness. A real promotion decision requires a non-empty time-split dataset generated from verified discovery, payment-chain, ledger, and engagement evidence, plus subgroup review, latency/cost bounds, human approval, and a rollback target.
