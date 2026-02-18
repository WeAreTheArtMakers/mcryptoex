# Phase 3 Run Check

## Objective

Validate Movement 3 Tempo pipeline:

1. `dex_tx_raw` note publication
2. validation to `dex_tx_valid`
3. immutable ledger writes in Postgres
4. analytics materialization in ClickHouse

## Bring-up

```bash
cp .env.example .env
docker compose up --build -d
```

## End-to-end check

```bash
python3 scripts/e2e_pipeline_check.py
```

Expected output contains:

- `status: ok`
- generated `note_id`
- generated `tx_hash`

## Manual API checks

```bash
curl -s http://localhost:8500/health/ready
curl -s http://localhost:8500/ledger/recent?limit=10
curl -s http://localhost:8500/analytics?minutes=180
```

## Debug swap note trigger

```bash
curl -s -X POST http://localhost:8500/debug/emit-swap-note \
  -H 'content-type: application/json' \
  -d '{
    "chain_id":31337,
    "action":"SWAP",
    "token_in":"mUSD",
    "token_out":"WETH",
    "amount_in":"100.0",
    "amount_out":"0.03"
  }'
```

## Optional indexer chain mode

Set these in `.env` to poll real on-chain logs:

- `INDEXER_RPC_URL`
- `INDEXER_PAIR_ADDRESSES`
- `INDEXER_STABILIZER_ADDRESSES`
- `INDEXER_START_BLOCK`

## Shutdown

```bash
docker compose down -v
```
