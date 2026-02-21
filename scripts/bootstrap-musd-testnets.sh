#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/packages/contracts"
RPC_WRAPPER="$ROOT_DIR/scripts/with-resolved-rpc.sh"
SEED_WRAPPER="$ROOT_DIR/scripts/run-seed-ohlc.sh"

run_chain() {
  local chain="$1"
  echo "============================================================"
  echo "[mUSD bootstrap] chain=${chain}"
  echo "============================================================"
  "$RPC_WRAPPER" "$chain" npm --prefix "$CONTRACTS_DIR" run "deploy:${chain}"
  "$RPC_WRAPPER" "$chain" npm --prefix "$CONTRACTS_DIR" run "bootstrap:allpairs:${chain}"
  "$SEED_WRAPPER" "$chain"
}

run_chain "bscTestnet"
run_chain "sepolia"

(
  cd "$ROOT_DIR"
  npm run registry:generate
)

echo "[mUSD bootstrap] completed for bscTestnet + sepolia"
