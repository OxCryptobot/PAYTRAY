# PayTray Phase 3 Weeks 3–4 Evaluation Export Contract

**Dataset version:** `phase3-ranking-v1`  
**Baseline:** Phase 2 `weighted_explainable_baseline`  
**Decision authority:** Evaluation and shadow analysis only; no ranking or financial state is changed by this pipeline.

## Export source and label policy

The export may use durable expert profiles, engagement contexts, verified outcome events, verified payment-chain events, and verified ledger entries. It must exclude raw messages, call media, private keys, signatures, and unverified participant reports from train, validation, and test labels. Unverified reports may be exported only to the `shadow` split for data-quality analysis.

A positive ranking label must be supported by a verified event. The initial label hierarchy is: `completed` for a verified meeting completion, `payment_intent` for a durable intent linked to the engagement, `repeat_booking` for a verified repeat engagement, and `disputed` as a negative trust signal. A query/candidate example must include its source event IDs and the timestamp at which the candidate features were known.

## Temporal split

The export uses a time split, never a random row split. The export command receives `--train-before`, `--validation-before`, and `--as-of` boundaries. Examples are assigned to `train`, `validation`, or `test` by their event/evidence timestamp. No example may use a source event after its `as_of` timestamp. The `shadow` split is reserved for unverified or currently ineligible evidence.

## Required example fields

| Field | Requirement |
|---|---|
| `datasetVersion` | Immutable identifier for the export contract and query logic. |
| `queryId` | Stable search/engagement query identifier. |
| `candidateProfileId` | Durable expert profile identifier. |
| `engagementId` | Optional engagement linkage; required for engagement-derived labels. |
| `labelType` / `labelValue` | Explicit target and numeric relevance. |
| `labelVerificationStatus` | `verified`, `unverified`, or `rejected`; only verified labels may enter train/validation/test. |
| `split` | Time-based `train`, `validation`, `test`, or evidence-only `shadow`. |
| `asOf` | Point-in-time feature/evidence boundary. |
| `sourceEventIds` | Durable evidence identifiers. |
| `provenance` | Query version, extraction version, policy version, and redaction state. |

## Comparison contract

The comparison must report precision@k, recall@k, and nDCG@k for the Phase 2 baseline and any candidate ranking implementation on the same test examples. It must report query count, coverage, zero-positive queries, per-query results, and data exclusions. Any candidate that cannot be reproduced from the dataset version and code revision remains shadow-only.

## Promotion gates

No candidate leaves shadow mode without (1) a completed time-split evaluation, (2) verified label coverage, (3) baseline comparison, (4) subgroup/fairness review where applicable, (5) model/version/input provenance, (6) cost and latency bounds, (7) human approval, and (8) an explicit rollback target of the Phase 2 baseline. The export itself never mutates profiles, rankings, payments, ledgers, reputations, or user-visible financial state.
