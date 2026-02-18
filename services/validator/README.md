# services/validator

Movement 3 Note validator (Section).

## Purpose

- Consume `dex_tx_raw` Notes.
- Validate required fields, numeric formats, and allowed actions.
- Emit validated Notes (`DexTxValid`) to `dex_tx_valid`.
- Route invalid payloads to `dex_dlq`.
