# mCryptoEx Docker Infra

Baseline stack ported from Polyphony patterns for Movement 1:

- Redpanda + Schema Registry
- Postgres
- ClickHouse
- OpenTelemetry Collector + Jaeger
- Prometheus + Grafana
- API/Web and Tempo workers
  - `indexer-local`
  - `indexer-ethereum`
  - `indexer-bnb`
  - `validator`
  - `ledger-writer`

Run from repository root:

```bash
cp .env.example .env
docker compose up --build
```
