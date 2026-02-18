# mCryptoEx

Orchestra-grade non-custodial DEX monorepo.

## Current status

- Phase 0 audit: `docs/ARCHITECTURE.md`
- Phase 1 foundation: monorepo scaffold + infra baseline
- Phase 2 contracts: mUSD + Harmony Engine + tests
- Phase 3 tempo pipeline: Protobuf Notes + validator + ledger-writer + analytics rollups

## Quick start

```bash
cp .env.example .env
docker compose up --build
python3 scripts/e2e_pipeline_check.py
```

## Main folders

- `apps/web` - Orchestra UI (MVP will be expanded in Movement 4)
- `apps/api` - Tempo API (`/quote`, `/tokens`, `/pairs`, `/analytics`, `/ledger/recent`)
- `services/indexer` - chain Notes producer (EVM event poller + optional simulation mode)
- `services/validator` - Notes validator (`dex_tx_raw` -> `dex_tx_valid`)
- `services/ledger-writer` - immutable ledger writer (`dex_tx_valid` -> Postgres + ClickHouse + outbox)
- `packages/contracts` - smart contracts workspace
- `packages/sdk` - shared TypeScript SDK
- `packages/proto` - protobuf Note schemas
- `packages/ui` - shared UI package
- `infra/docker` - compose and observability stack
