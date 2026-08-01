# PayTray

PayTray is a Phase 1 skeleton for an AI platform that combines expert discovery, real-time communication, and blockchain payments.

This repository has been reduced to a minimal starting point for development:

- `MasterBlueprint.md` defines the target architecture and roadmap.
- `packages/backend` contains the backend skeleton.
- Root scripts are scoped to the backend workspace only.

## Start Here

```bash
npm install
npm run backend:dev
```

## Current Scope

The codebase is intentionally small and focused on Phase 1 infrastructure work:

- identity and trust primitives
- minimal API foundation
- database schema initialization
- baseline testing and linting

The old peerstream implementation, deployment cruft, and unrelated application surface have been removed so the team can build forward from a clean baseline.