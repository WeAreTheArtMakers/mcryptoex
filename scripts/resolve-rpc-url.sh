#!/usr/bin/env bash
set -euo pipefail

NETWORK="${1:-bscTestnet}"
TIMEOUT_SEC="${RPC_RESOLVE_TIMEOUT_SEC:-5}"

trim() {
  local value="$1"
  # shellcheck disable=SC2001
  echo "$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
}

append_candidate() {
  local value
  value="$(trim "$1")"
  [[ -n "$value" ]] || return 0
  for existing in "${CANDIDATES[@]:-}"; do
    [[ "$existing" == "$value" ]] && return 0
  done
  CANDIDATES+=("$value")
}

append_csv_candidates() {
  local csv="$1"
  [[ -n "$csv" ]] || return 0
  IFS=',' read -r -a items <<<"$csv"
  for item in "${items[@]}"; do
    append_candidate "$item"
  done
}

probe_rpc() {
  local url="$1"
  local expected_chain_hex="$2"
  local payload='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
  local body compact
  body="$(curl -sS --max-time "$TIMEOUT_SEC" -H 'content-type: application/json' --data "$payload" "$url" 2>/dev/null || true)"
  compact="$(printf '%s' "$body" | tr -d '\n\r\t ')"
  [[ -n "$compact" ]] || return 1
  [[ "$compact" == *"\"result\":\"$expected_chain_hex\""* ]]
}

NETWORK_KEY="$(echo "$NETWORK" | tr '[:upper:]' '[:lower:]')"
CANDIDATES=()
EXPECTED_CHAIN_HEX=""

case "$NETWORK_KEY" in
  bsc|bsctestnet|bsc_testnet|bsc-testnet|bnb|bnb-testnet)
    EXPECTED_CHAIN_HEX="0x61"
    append_csv_candidates "${BSC_TESTNET_RPC_URL_CANDIDATES:-}"
    append_candidate "${BSC_TESTNET_RPC_URL:-}"
    append_candidate "https://bsc-testnet-rpc.publicnode.com"
    append_candidate "https://bsc-testnet.blockpi.network/v1/rpc/public"
    append_candidate "https://bsc-testnet.public.blastapi.io"
    append_candidate "https://rpc.ankr.com/bsc_testnet_chapel"
    ;;
  sepolia|ethereum-sepolia|eth-sepolia)
    EXPECTED_CHAIN_HEX="0xaa36a7"
    append_csv_candidates "${SEPOLIA_RPC_URL_CANDIDATES:-}"
    append_candidate "${SEPOLIA_RPC_URL:-}"
    append_candidate "https://ethereum-sepolia-rpc.publicnode.com"
    append_candidate "https://ethereum-sepolia.blockpi.network/v1/rpc/public"
    append_candidate "https://rpc.sepolia.org"
    ;;
  *)
    echo "unsupported network: $NETWORK" >&2
    exit 2
    ;;
esac

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "no RPC candidates configured for network=$NETWORK" >&2
  exit 3
fi

for candidate in "${CANDIDATES[@]}"; do
  if probe_rpc "$candidate" "$EXPECTED_CHAIN_HEX"; then
    echo "$candidate"
    exit 0
  fi
done

echo "no reachable RPC endpoint for network=$NETWORK (candidates=${#CANDIDATES[@]})" >&2
exit 4
