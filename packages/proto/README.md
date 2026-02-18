# packages/proto

Protobuf Note schemas used in Movement 3 Tempo pipeline:

- `dex_tx_raw.proto`
  - produced by `services/indexer` and debug API
  - topic: `dex_tx_raw`
- `dex_tx_valid.proto`
  - produced by `services/validator`
  - topic: `dex_tx_valid`
- `dex_ledger_entry_batch.proto`
  - produced by `services/ledger-writer`
  - topic: `dex_ledger_entries`
