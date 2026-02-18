# Phase 1 Run Check

## Bring-up

```bash
cp .env.example .env
docker compose up --build
```

## Key endpoints

- API health: `http://localhost:8500/health`
- Web placeholder: `http://localhost:3300`
- Redpanda Console: `http://localhost:8088`
- Grafana: `http://localhost:3400`
- Prometheus: `http://localhost:9095`
- Jaeger: `http://localhost:16696`

## Shutdown

```bash
docker compose down -v
```
