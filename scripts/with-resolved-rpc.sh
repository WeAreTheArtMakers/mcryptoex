#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <bscTestnet|sepolia> <command...>" >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="$1"
shift

RPC_URL="$("$ROOT_DIR/scripts/resolve-rpc-url.sh" "$NETWORK")"

case "$(echo "$NETWORK" | tr '[:upper:]' '[:lower:]')" in
  bsc|bsctestnet|bsc_testnet|bsc-testnet|bnb|bnb-testnet)
    RPC_ENV_KEY="BSC_TESTNET_RPC_URL"
    ;;
  sepolia|ethereum-sepolia|eth-sepolia)
    RPC_ENV_KEY="SEPOLIA_RPC_URL"
    ;;
  *)
    echo "unsupported network: $NETWORK" >&2
    exit 65
    ;;
esac

echo "[rpc] network=$NETWORK selected=$RPC_URL"
exec env "$RPC_ENV_KEY=$RPC_URL" "$@"
