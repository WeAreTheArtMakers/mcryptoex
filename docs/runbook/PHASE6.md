# Phase 6 Run Check

## Objective

Validate cross-chain adapter boundaries and chain-aware indexing baseline:

1. chain registry is generated from deployment artifacts
2. indexer workers run per chain key (`hardhat-local`, `ethereum-sepolia`, `bnb-testnet`)
3. Tempo API serves `/tokens` and `/risk/assumptions` from registry
4. `/harmony` chain selector and risk panel use registry-backed API responses

## Generate registry

```bash
python3 scripts/generate_chain_registry.py
```

## Compose bring-up

```bash
cp .env.example .env
docker compose up --build
```

Expected indexer services:

- `indexer-local`
- `indexer-ethereum`
- `indexer-bnb`

## Endpoint checks

```bash
curl -sS "http://localhost:8500/tokens"
curl -sS "http://localhost:8500/risk/assumptions?chain_id=97"
```

## Full check bundle

```bash
npm run check:phase6
```
