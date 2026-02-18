# mCryptoEx

Orchestra-grade non-custodial DEX monorepo.

## Current status

- Phase 0 audit: `docs/ARCHITECTURE.md`
- Phase 1 foundation: monorepo scaffold + infra baseline + placeholder services

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

## Main folders

- `apps/web` - Orchestra UI (placeholder in Phase 1)
- `apps/api` - Tempo API (placeholder in Phase 1)
- `services/indexer` - chain Notes producer (placeholder in Phase 1)
- `services/validator` - Notes validator (placeholder in Phase 1)
- `services/ledger-writer` - immutable ledger writer (placeholder in Phase 1)
- `packages/contracts` - smart contracts workspace
- `packages/sdk` - shared TypeScript SDK
- `packages/proto` - protobuf Note schemas
- `packages/ui` - shared UI package
- `infra/docker` - compose and observability stack

