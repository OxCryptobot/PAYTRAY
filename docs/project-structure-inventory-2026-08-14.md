# Paytray Project Structure Inventory

**Date:** 2026-08-14  
**Scope inspected:** sandbox working copy at `/home/ubuntu/projects/PAYTRAY` and GitHub `OxCryptobot/PAYTRAY` default branch

## Repository baseline

The GitHub `master` branch is a deliberately minimal Phase 1 backend skeleton. Its tracked structure contains one backend package, one initial schema migration, root documentation, and no duplicate source folders. The sandbox working copy contains the planned financial-core implementation tranche as uncommitted additions and edits.

## Classification

| Category | Files or folders | Cleanup decision |
|---|---|---|
| Active tracked baseline | `README.md`, `MasterBlueprint.md`, root package files, `packages/backend/**` | Retain. These are the source-of-record baseline. |
| Active financial-core implementation | `packages/backend/lib/payments/**`, `lib/migrations.js`, `migrations/002_financial_core.sql`, new test files | Retain. These are source code and verification for the current build tranche. |
| Active product/engineering documentation | `docs/adr/**`, `docs/api/**`, `docs/payments/**`, `docs/evidence/**`, corrected audit | Retain and keep under the existing `docs/` taxonomy. No duplicate documentation was detected. |
| Generated handoff artifact | `paytray-financial-core-tranche.patch` | Safe to delete from the repository working tree after the changes are committed or otherwise backed up. It is a generated synchronization artifact, not source. |
| Dependency/cache directories | `node_modules/` | Not tracked and excluded from duplicate analysis; retain locally for development, never commit. |

## Duplicate analysis

A SHA-256 comparison of all non-ignored source and documentation files found **no identical duplicate files**. The GitHub default branch tree also contains no duplicate source folders or legacy application directories.

## Recommended clean structure

```text
PAYTRAY/
├── docs/
│   ├── adr/          # architecture decisions
│   ├── api/          # compatibility and API contracts
│   ├── evidence/     # primary-source product/protocol evidence
│   └── payments/     # lifecycle, threat model, implementation records
├── packages/
│   └── backend/
│       ├── lib/
│       │   └── payments/   # financial domain modules
│       ├── migrations/     # versioned database migrations
│       └── tests/          # API, domain, repository, migration tests
├── MasterBlueprint.md
├── README.md
└── package.json
```

## Cleanup boundary

The sandbox cannot directly access the user’s Windows folder `C:\Users\Otcde\PAYTRAY-master`. GitHub remains unchanged because no commit or push has been performed. The only safe deletion candidate identified in the sandbox is the generated patch file named above. Deleting it does not remove implementation work.
