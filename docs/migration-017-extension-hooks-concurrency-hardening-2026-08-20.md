# Migration-017 Extension-Hook Concurrency Hardening

**Date:** 2026-08-20
**Repository:** `OxCryptobot/PAYTRAY`
**Branch:** `paytray/batch-delivery`
**Evidence boundary:** fresh local disposable PostgreSQL only

## Contract coverage

The new `verify-migration-017-extension-hooks.mjs` verifier covers the migration-017 database invariants and service-facing lifecycle behavior:

| Case | Expected result |
|---|---|
| Required catalog indexes | Both event/active and owner/active indexes present |
| Valid hook defaults | `api_version=v2`, replay window 300, `active=true` |
| Invalid API version | SQLSTATE `23514` |
| Replay window below 60 seconds | SQLSTATE `23514` |
| Replay window above 86,400 seconds | SQLSTATE `23514` |
| Missing owner wallet | SQLSTATE `23502` |
| Concurrent deactivation | One winner, one loser, zero active rows afterward |

The contract ran on a fresh local disposable PostgreSQL database, cleaned six fixture hook IDs, and returned `status=verified`. The deactivation race used two PostgreSQL clients issuing the same guarded `UPDATE ... WHERE active = true RETURNING id`; exactly one client returned a row and the other returned no row. No duplicate state transition was observed.

## Component integration

The targeted component suite passed four tests: three outbox/extension-hook tests and one 100-event webhook replay-load test. Existing service tests continue to cover owner normalization, active-hook listing, bounded worker ticks, concurrent tick suppression, exact signatures, and duplicate replay rejection.

## CI integration

The verifier is wired into the isolated PostgreSQL route contract and restored recovery contract jobs. The restored migration-017 artifact is included in the recovery SHA-256 sidecar, recovery artifact verification input, and uploaded redacted evidence set. The package script is:

```bash
npm run backend:release:migration:017:check
```

## Strict interpretation

This batch is engineering evidence only. It does not establish production capacity, target readiness, deployment success, human approval, release eligibility, payment mutation, or settlement authority. It preserves `releaseEligible=false`, `settlementAuthority=false`, and `mutation=read_only`. No live funds, mainnet transactions, real user data, human decision, reviewer identity, approval token, private key, or Railway setting was fabricated or used.
