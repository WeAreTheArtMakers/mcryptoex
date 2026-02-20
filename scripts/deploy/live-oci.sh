#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "missing .env in $ROOT_DIR"
  exit 1
fi

if ! grep -qE '^PUBLIC_DOMAIN=' .env; then
  echo "PUBLIC_DOMAIN is required in .env"
  exit 1
fi

if ! grep -qE '^ACME_EMAIL=' .env; then
  echo "ACME_EMAIL is required in .env"
  exit 1
fi

echo "[deploy] generating chain registry"
python3 scripts/generate_chain_registry.py

echo "[deploy] pulling/building services"
docker compose \
  -f docker-compose.yml \
  -f infra/deploy/oci/docker-compose.live.yml \
  up -d --build

echo "[deploy] waiting for public gateway"
public_domain="$(grep -E '^PUBLIC_DOMAIN=' .env | tail -n 1 | cut -d '=' -f 2-)"
for i in $(seq 1 20); do
  if curl -fsS -H "Host: ${public_domain}" http://127.0.0.1/health >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

echo "[deploy] status"
docker compose \
  -f docker-compose.yml \
  -f infra/deploy/oci/docker-compose.live.yml \
  ps

echo "[deploy] done"
echo "web: https://${public_domain}"
echo "api: https://${public_domain}/api/health"
