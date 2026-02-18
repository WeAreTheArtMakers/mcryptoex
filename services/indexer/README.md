# services/indexer

Movement 3 chain indexer (Section) for mCryptoEx.

## Purpose

- Poll EVM logs for Harmony and mUSD/Stabilizer events.
- Normalize on-chain actions into Protobuf `DexTxRaw` Notes.
- Publish raw Notes to Redpanda topic `dex_tx_raw`.

## Key env vars

- `INDEXER_RPC_URL`
- `INDEXER_CHAIN_ID`
- `INDEXER_PAIR_ADDRESSES`
- `INDEXER_STABILIZER_ADDRESSES`
- `DEX_TX_RAW_TOPIC`
- `INDEXER_ENABLE_SIMULATION`

When chain addresses are not configured, the indexer stays idle (or can emit synthetic notes if simulation is enabled).
