# mCryptoEx Docker Infra

Baseline stack ported from Polyphony patterns for Movement 1:

- Redpanda + Schema Registry
- Postgres
- ClickHouse
- OpenTelemetry Collector + Jaeger
- Prometheus + Grafana
- Placeholder API/Web/Worker services

Run from repository root:

```bash
cp .env.example .env
docker compose up --build
```
