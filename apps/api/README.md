# apps/api

Tempo API (FastAPI) for mCryptoEx.

## Endpoints (Movement 3)

- `GET /health`
- `GET /health/ready`
- `GET /tokens`
- `GET /quote`
- `GET /pairs`
- `GET /analytics`
- `GET /ledger/recent`
- `POST /debug/emit-swap-note`

The debug endpoint is used to validate the Phase 3 pipeline end-to-end without requiring external RPC event streams.

## Optional compliance hooks

Operator toggles (all optional):

- `COMPLIANCE_ENFORCEMENT_ENABLED` (default `false`)
- `COMPLIANCE_BLOCKED_COUNTRIES` (csv, e.g. `ir,kp`)
- `COMPLIANCE_SANCTIONS_BLOCKED_WALLETS` (csv of lowercase EVM addresses)

When enabled:

- `/quote` checks `country_code` and optional `wallet_address`
- `/debug/emit-swap-note` checks `user_address`
