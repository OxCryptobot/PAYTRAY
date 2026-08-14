# PayTray Phase 3 AI Data and Evaluation Contract

**Status:** Phase 3 Weeks 1–2 foundation  
**Authority:** Verified payment/session evidence and durable engagement records; AI outputs remain advisory

## Data authority policy

PayTray may use AI to improve discovery, engagement preparation, summaries, and risk triage, but AI must not become the source of economic truth. Verified protocol/indexer evidence establishes payment state. Verified session and outcome evidence establishes trusted engagement labels. Participant-reported outcome events remain unverified until a defined verification policy accepts them.

| Data class | Allowed use | Trust state | Retention principle |
|---|---|---|---|
| Profile and search fields | Candidate retrieval and ranking | Product data; user-editable | Retain while profile is active, then delete or anonymize under account policy. |
| Verified payment events and ledger entries | Payment reliability and paid-time features | Financial evidence | Retain according to financial/audit policy; never overwrite source events. |
| Verified session outcomes | Completion, dispute, repeat-booking labels | Outcome evidence | Retain with provenance and engagement linkage. |
| Participant reports | Workflow triage and pending labels | Unverified | Do not train ranking or risk truth until verified. |
| Raw messages, call media, and artifacts | Assistant input only with authorization and consent | Sensitive collaboration data | Do not copy into feature snapshots; retain only under explicit content policy. |
| Derived feature snapshots | Evaluation and model input | Versioned derivative | Store feature version, as-of time, source IDs, privacy class, and retention deadline. |
| AI outputs | Advisory explanation, summary, or risk signal | Non-authoritative | Store model/version, prompt or input reference hash, confidence, reviewer state, and rollback context. |

## Point-in-time and provenance requirements

Every feature snapshot must include an `as_of` timestamp and must use only events available at or before that time. Every derived field must be attributable to a source event, profile snapshot, or explicit deterministic transformation. Labels must identify their evidence type and verification status. Training and evaluation splits must be created by time or engagement boundary to prevent future leakage.

## AI authority and review policy

Ranking may recommend ordering but must expose an explanation and remain rollbackable to the Phase 2 weighted baseline. Conversation assistance may produce goals, questions, summaries, and action items, but users must be able to edit, reject, or delete them. Risk scoring may create a reason-coded review signal, but it must not autonomously freeze a stream, deny a withdrawal, alter reputation, or change ledger state.

## Privacy and retention requirements

Feature snapshots must not contain raw message bodies, call recordings, private keys, signatures, or unrestricted wallet-identity graphs. Sensitive inputs are referenced by stable hashes or source IDs. Access is limited by engagement authorization and operator scope. Each dataset, snapshot, evaluation run, and shadow decision has a retention deadline and deletion/anonymization policy reference.

## Evaluation gates

A model or rule set may leave shadow mode only when the evaluation run records its dataset version, baseline comparison, time split, metrics, subgroup checks where applicable, reviewer decision, rollback target, and known limitations. No AI feature is production-authoritative merely because it has a high score on a test set.
