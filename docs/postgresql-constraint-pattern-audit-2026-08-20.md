# PostgreSQL constraint summary for CI run 32388405081

Bound commit: `7ed8ae539bfe81cba9223fd6ad3bb46bf2275ab1`

## SQLSTATE and message-pattern summary

| Family | Expected SQLSTATE | Records | Message matches | SQLSTATE tokens observed in raw CI lines |
|---|---:|---:|---:|---:|
| `check` | `23514` | 46 | 46 | none; CI log contains text only |
| `unique` | `23505` | 8 | 8 | none; CI log contains text only |
| `foreign_key` | `23503` | 8 | 8 | none; CI log contains text only |
| `not_null` | `23502` | 2 | 2 | none; CI log contains text only |

The official PostgreSQL mapping is `23514` check_violation, `23505` unique_violation, `23503` foreign_key_violation, and `23502` not_null_violation. The retained GitHub Actions lines contain the standard human-readable PostgreSQL messages but no SQLSTATE token. The codes above are therefore expected mappings, not observed fields in this log artifact.

## CHECK records: all 46

| Log line | Job | Relation | Constraint | Message pattern |
|---:|---|---|---|---|
| 5243 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_status_check` | `23514` / check violation |
| 5252 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_check` | `23514` / check violation |
| 5261 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_check` | `23514` / check violation |
| 5270 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_check` | `23514` / check violation |
| 5279 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_check1` | `23514` / check violation |
| 5288 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_check3` | `23514` / check violation |
| 5297 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_check4` | `23514` / check violation |
| 5306 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_check2` | `23514` / check violation |
| 5315 | Isolated PostgreSQL route contract | `operations_quality_runs` | `operations_quality_runs_report_hash_check` | `23514` / check violation |
| 5357 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_polarity_check` | `23514` / check violation |
| 5365 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_score_check` | `23514` / check violation |
| 5373 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_eligible_for_ranking_check` | `23514` / check violation |
| 5389 | Isolated PostgreSQL route contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_role_check` | `23514` / check violation |
| 5396 | Isolated PostgreSQL route contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_artifact_sha256_check` | `23514` / check violation |
| 5403 | Isolated PostgreSQL route contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_check` | `23514` / check violation |
| 5440 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_applied_check` | `23514` / check violation |
| 5450 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_release_eligible_check` | `23514` / check violation |
| 5460 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_settlement_authority_check` | `23514` / check violation |
| 5470 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_deployment_performed_check` | `23514` / check violation |
| 5480 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_settlement_mutation_performed_check` | `23514` / check violation |
| 5490 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_mutation_check` | `23514` / check violation |
| 5500 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_check2` | `23514` / check violation |
| 5520 | Isolated PostgreSQL route contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_check1` | `23514` / check violation |
| 7185 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_status_check` | `23514` / check violation |
| 7194 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_check` | `23514` / check violation |
| 7203 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_check` | `23514` / check violation |
| 7212 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_check` | `23514` / check violation |
| 7221 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_check1` | `23514` / check violation |
| 7230 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_check3` | `23514` / check violation |
| 7239 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_check4` | `23514` / check violation |
| 7248 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_check2` | `23514` / check violation |
| 7257 | Disposable backup and isolated recovery contract | `operations_quality_runs` | `operations_quality_runs_report_hash_check` | `23514` / check violation |
| 7275 | Disposable backup and isolated recovery contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_role_check` | `23514` / check violation |
| 7282 | Disposable backup and isolated recovery contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_artifact_sha256_check` | `23514` / check violation |
| 7289 | Disposable backup and isolated recovery contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_check` | `23514` / check violation |
| 7326 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_applied_check` | `23514` / check violation |
| 7336 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_release_eligible_check` | `23514` / check violation |
| 7346 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_settlement_authority_check` | `23514` / check violation |
| 7356 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_deployment_performed_check` | `23514` / check violation |
| 7366 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_settlement_mutation_performed_check` | `23514` / check violation |
| 7376 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_mutation_check` | `23514` / check violation |
| 7386 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_check2` | `23514` / check violation |
| 7406 | Disposable backup and isolated recovery contract | `reviewer_attestation_challenges` | `reviewer_attestation_challenges_check1` | `23514` / check violation |
| 7437 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_polarity_check` | `23514` / check violation |
| 7445 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_score_check` | `23514` / check violation |
| 7453 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_eligible_for_ranking_check` | `23514` / check violation |

## Foreign-key records: all 8

| Log line | Job | Table | Constraint | Expected SQLSTATE |
|---:|---|---|---|---:|
| 5333 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_subject_user_id_fkey` | `23503` |
| 5341 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_engagement_id_fkey` | `23503` |
| 5349 | Isolated PostgreSQL route contract | `verified_trust_signals` | `verified_trust_signals_outcome_id_fkey` | `23503` |
| 5410 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_attestations_challenge_id_fkey` | `23503` |
| 7296 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_attestations_challenge_id_fkey` | `23503` |
| 7413 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_subject_user_id_fkey` | `23503` |
| 7421 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_engagement_id_fkey` | `23503` |
| 7429 | Disposable backup and isolated recovery contract | `verified_trust_signals` | `verified_trust_signals_outcome_id_fkey` | `23503` |

## NOT NULL records: all 2

| Log line | Job | Relation | Column | Expected SQLSTATE |
|---:|---|---|---|---:|
| 5510 | Isolated PostgreSQL route contract | `reviewer_attestations` | `reviewer_wallet` | `23502` |
| 7396 | Disposable backup and isolated recovery contract | `reviewer_attestations` | `reviewer_wallet` | `23502` |

Validation: `True`; all message patterns matched and no records were unclassified.

## Interpretation boundary

The expected SQLSTATE mappings are `23514` for `check_violation`, `23505` for `unique_violation`, `23503` for `foreign_key_violation`, and `23502` for `not_null_violation`.[1] The GitHub Actions records preserve the human-readable server messages but do not include SQLSTATE tokens. Therefore, the mappings in this report are **expected codes derived from the matched PostgreSQL message family**, not observed SQLSTATE fields. The reusable auditor reports this explicitly as `missingExpectedSqlStateInRawLog` and does not silently promote the inferred mapping to observed evidence.

The exact raw records remain in [`ci-negative-path-lines-32388405081.json`](./ci-negative-path-lines-32388405081.json). The successful pattern match demonstrates that the recorded messages have the expected PostgreSQL forms; it does not replace database-driver-level SQLSTATE assertions in a live contract test.

## References

[1]: https://www.postgresql.org/docs/current/errcodes-appendix.html "PostgreSQL Appendix A: Error Codes"
