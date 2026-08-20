# PayTray Staging Compatibility Dry-Run

**Repository:** PayTray
**Branch:** `paytray/batch-delivery`
**Commit under test:** `4ad981061cbea3b29c6f2d362aec32681624e07e`
**Date:** 2026-08-20
**Mode:** non-mutating local configuration and target-evidence preflight

## Result

The development configuration preflight passed its local checks for a staging-target simulation using Base Sepolia chain ID `84532` and `PAYMENT_MAINNET_ENABLED=false`. The Railway compatibility check correctly returned `status=settings_unavailable` because no authenticated Railway URL, settings, or metadata were supplied. This is the expected fail-closed result; it does not indicate a successful staging deployment or target compatibility.

No network call, deployment, database mutation, chain transaction, settlement mutation, reviewer decision, or release-authority transition occurred.

## Exact checks

| Check | Result |
|---|---|
| `DEPLOYMENT_TARGET=staging NODE_ENV=development PAYMENT_MAINNET_ENABLED=false SETTLEMENT_CHAIN_ID=84532 npm run backend:deployment:check` | Exit 0; `ready=true`; `authority=configuration_preflight_only`; `mutation=read_only`; `deploymentPerformed=false`. |
| `DEPLOYMENT_TARGET=staging NODE_ENV=development PAYMENT_MAINNET_ENABLED=false SETTLEMENT_CHAIN_ID=84532 npm run backend:railway:trial:check` | Exit 1; `status=settings_unavailable`; no target URL/settings/metadata; `networkCallPerformed=false`; `deploymentPerformed=false`. |
| Base chain boundary | `chainId=84532`; mainnet disabled. |
| Skill validation | `Skill is valid!`; archive schema `compatible`. |

The local preflight checks were development-deferred for database, JWT, RPC, protocol, webhook signing, and token-registry deployment requirements. Only the bounded verifier-cursor threshold and Base Sepolia/mainnet gate were locally evaluated as configuration checks. The preflight’s `ready=true` therefore means development configuration shape is acceptable; it does not prove staging secret injection, service health, target PostgreSQL readiness, RPC availability, or Railway settings.

## Skill package schema verification

The final package is `paytray-shadow-review-release-attestation-staging-dry-run.skill`. The deterministic schema checker reports:

```json
{
  "entries": 27,
  "skillEntry": "paytray-shadow-review-release-attestation/SKILL.md",
  "hasSingleSkillMd": true,
  "hasName": true,
  "hasDescription": true,
  "skillLineCount": 121,
  "under500Lines": true,
  "stepCount": 26,
  "sequentialSteps": true,
  "hasReadme": false,
  "hasChangelog": false,
  "schemaStatus": "compatible"
}
```

The package includes 21 reference files, including the new `staging-compatibility-dry-run.md`. The package SHA-256 is:

`40f35f79f58199a26f0b649638513c5c31c408f8b1ae24fc2e0e88e8b3ad53ee`

## Safety envelope

```json
{
  "releaseEligible": false,
  "settlementAuthority": false,
  "mutation": "read_only",
  "applied": false,
  "deploymentPerformed": false,
  "networkCallPerformed": false,
  "settlementMutationPerformed": false
}
```

Railway remains `settings_unavailable` until authenticated target evidence is genuinely supplied. Do not infer or fabricate Railway settings, service metadata, reviewer approvals, operator keys, or deployment success from this local dry-run.
