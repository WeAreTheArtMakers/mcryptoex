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
