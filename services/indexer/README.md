# services/indexer

Movement 3 chain indexer (Section) for mCryptoEx.

## Purpose

- Poll EVM logs for Harmony and mUSD/Stabilizer events.
- Normalize on-chain actions into Protobuf `DexTxRaw` Notes.
- Publish raw Notes to Redpanda topic `dex_tx_raw`.

## Key env vars

- `CHAIN_REGISTRY_PATH`
- `INDEXER_CHAIN_KEY` (e.g. `ethereum-sepolia`, `bnb-testnet`, `hardhat-local`)
- `INDEXER_RPC_URL` (optional override; falls back to chain registry `rpc_env_key`)
- `INDEXER_PAIR_ADDRESSES` (optional override)
- `INDEXER_STABILIZER_ADDRESSES` (optional override)
- `INDEXER_REGISTRY_REFRESH_SECONDS` (default `30`; auto-refresh pair/stabilizer watchlists from registry)
- `DEX_TX_RAW_TOPIC`
- `INDEXER_ENABLE_SIMULATION`

When chain addresses are not configured, the indexer stays idle (or can emit synthetic notes if simulation is enabled).
If `INDEXER_PAIR_ADDRESSES` / `INDEXER_STABILIZER_ADDRESSES` are not manually overridden, the worker refreshes watchlists from the generated chain registry on every `INDEXER_REGISTRY_REFRESH_SECONDS` interval.
