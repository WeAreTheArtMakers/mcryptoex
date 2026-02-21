#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${1:-bscTestnet}"
SEED_SCRIPT="seed:ohlc:${NETWORK}"

EXTRA_ENV=()
if [[ -n "${OHLC_SEED_PRIVATE_KEY:-}" ]]; then
  EXTRA_ENV+=("PRIVATE_KEY=${OHLC_SEED_PRIVATE_KEY}")
fi

if ((${#EXTRA_ENV[@]} > 0)); then
  "$ROOT_DIR/scripts/with-resolved-rpc.sh" "$NETWORK" env "${EXTRA_ENV[@]}" npm --prefix "$ROOT_DIR/packages/contracts" run "$SEED_SCRIPT"
else
  "$ROOT_DIR/scripts/with-resolved-rpc.sh" "$NETWORK" npm --prefix "$ROOT_DIR/packages/contracts" run "$SEED_SCRIPT"
fi
