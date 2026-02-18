# services/ledger-writer

Movement 3 immutable ledger writer (Section).

## Purpose

- Consume validated Notes (`dex_tx_valid`).
- Write immutable transaction + double-entry rows into Postgres.
- Emit `DexLedgerEntryBatch` to `dex_ledger_entries`.
- Emit outbox messages to `dex_outbox`.
- Persist denormalized raw events to ClickHouse (`dex_transactions_raw`).

## Topics

- Consumes: `dex_tx_valid`
- Produces: `dex_ledger_entries`, `dex_outbox`
