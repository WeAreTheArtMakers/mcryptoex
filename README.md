# mCryptoEx

Orchestra-grade non-custodial DEX monorepo.

## Current status

- Phase 0 audit: `docs/ARCHITECTURE.md`
- Phase 1 foundation: monorepo scaffold + infra baseline
- Phase 2 contracts: mUSD + Harmony Engine + tests
- Phase 3 tempo pipeline: Protobuf Notes + validator + ledger-writer + analytics rollups
- Phase 4 frontend MVP: Next.js Orchestra UI with `/harmony` quote + wallet connect
- Phase 5 hardening: pause/path guardrails tests + security docs + CI baseline

## Quick start

```bash
cp .env.example .env
docker compose up --build
python3 scripts/e2e_pipeline_check.py
```

Phase 5 checks:

```bash
npm run check:phase5
```

Primary docs:

- `docs/ARCHITECTURE.md`
- `docs/RUNBOOK.md`
- `docs/SECURITY.md`
- `docs/THREAT_MODEL.md`
- `docs/MUSICAL_GLOSSARY.md`

## Main folders

- `apps/web` - Orchestra UI (Next.js + wagmi wallet connect + `/harmony` quote flow)
- `apps/api` - Tempo API (`/quote`, `/tokens`, `/pairs`, `/analytics`, `/ledger/recent`)
- `services/indexer` - chain Notes producer (EVM event poller + optional simulation mode)
- `services/validator` - Notes validator (`dex_tx_raw` -> `dex_tx_valid`)
- `services/ledger-writer` - immutable ledger writer (`dex_tx_valid` -> Postgres + ClickHouse + outbox)
- `packages/contracts` - smart contracts workspace
- `packages/sdk` - shared TypeScript SDK
- `packages/proto` - protobuf Note schemas
- `packages/ui` - shared UI package
- `infra/docker` - compose and observability stack
