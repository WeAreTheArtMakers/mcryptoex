#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${BOT_NETWORK:-bscTestnet}"
INTERVAL_SEC="${BOT_INTERVAL_SEC:-45}"
SYMBOLS="${BOT_SYMBOLS:-WBNB,USDC,USDT,MODX}"
ROUNDS="${BOT_ROUNDS:-1}"
SLIPPAGE_BPS="${BOT_SLIPPAGE_BPS:-90}"
REVERSE_AMOUNT="${BOT_REVERSE_MUSD_AMOUNT:-12}"
STRICT="${BOT_STRICT:-false}"
BOT_PRIVATE_KEY="${BOT_PRIVATE_KEY:-}"
SEED_WRAPPER="$ROOT_DIR/scripts/run-seed-ohlc.sh"
GAS_GUARD_MIN_NATIVE="${BOT_GAS_GUARD_MIN_NATIVE:-0.03}"
GAS_GUARD_MODE="$(echo "${BOT_GAS_GUARD_MODE:-stop}" | tr '[:upper:]' '[:lower:]')"
COOLDOWN_SEC="${BOT_COOLDOWN_SEC:-8}"
MAX_TRADES_PER_CYCLE="${BOT_MAX_TRADES_PER_CYCLE:-3}"
SIZE_JITTER_PCT="${BOT_SIZE_JITTER_PCT:-15}"
SLEEP_JITTER_SEC="${BOT_SLEEP_JITTER_SEC:-7}"
MAX_FAILURE_STREAK="${BOT_MAX_FAILURE_STREAK:-6}"
KILL_SWITCH_FILE="${BOT_KILL_SWITCH_FILE:-$ROOT_DIR/.bot-kill-switch}"
CONTRACTS_DIR="$ROOT_DIR/packages/contracts"

if [[ "$GAS_GUARD_MODE" != "stop" && "$GAS_GUARD_MODE" != "warn" ]]; then
  echo "unsupported BOT_GAS_GUARD_MODE=$GAS_GUARD_MODE (allowed: stop|warn)"
  exit 1
fi

if [[ "$NETWORK" != "bscTestnet" && "$NETWORK" != "sepolia" ]]; then
  echo "unsupported BOT_NETWORK=$NETWORK (allowed: bscTestnet|sepolia)"
  exit 1
fi

if ! [[ "$COOLDOWN_SEC" =~ ^[0-9]+$ && "$MAX_TRADES_PER_CYCLE" =~ ^[0-9]+$ && "$SLEEP_JITTER_SEC" =~ ^[0-9]+$ && "$MAX_FAILURE_STREAK" =~ ^[0-9]+$ ]]; then
  echo "cooldown/max-trade/jitter/failure values must be integer."
  exit 1
fi

if ! awk "BEGIN { exit !($SIZE_JITTER_PCT >= 0 && $SIZE_JITTER_PCT <= 95) }"; then
  echo "BOT_SIZE_JITTER_PCT must be between 0 and 95."
  exit 1
fi

run_gas_guard() {
  local guard_script="bot:gas-guard:${NETWORK}"
  local -a env_args
  env_args=("BOT_GAS_GUARD_MIN_NATIVE=$GAS_GUARD_MIN_NATIVE")
  if [[ -n "$BOT_PRIVATE_KEY" ]]; then
    env_args+=("PRIVATE_KEY=$BOT_PRIVATE_KEY")
  fi

  "$ROOT_DIR/scripts/with-resolved-rpc.sh" "$NETWORK" env "${env_args[@]}" npm --prefix "$CONTRACTS_DIR" run "$guard_script"
}

kill_switch_on() {
  [[ -f "$KILL_SWITCH_FILE" ]] || return 1
  local flag
  flag="$(tr -d '[:space:]' <"$KILL_SWITCH_FILE" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$flag" || "$flag" == "1" || "$flag" == "true" || "$flag" == "on" || "$flag" == "stop" ]]
}

randomized_reverse_amount() {
  local base="$1"
  local pct="$2"
  awk -v base="$base" -v pct="$pct" '
    BEGIN {
      srand();
      jitter = ((rand() * 2.0 * pct) - pct) / 100.0;
      value = base * (1.0 + jitter);
      if (value < 0.000001) value = 0.000001;
      printf "%.8f", value;
    }'
}

echo "market bot loop started network=${NETWORK} symbols=${SYMBOLS} interval=${INTERVAL_SEC}s gas_guard_min=${GAS_GUARD_MIN_NATIVE} mode=${GAS_GUARD_MODE} cooldown=${COOLDOWN_SEC}s max_trades_cycle=${MAX_TRADES_PER_CYCLE} kill_switch=${KILL_SWITCH_FILE}"

last_cycle_end=0
failure_streak=0

while true; do
  if kill_switch_on; then
    echo "kill switch active at ${KILL_SWITCH_FILE}; bot halted."
    exit 11
  fi

  now_epoch="$(date +%s)"
  if (( last_cycle_end > 0 )); then
    elapsed=$((now_epoch - last_cycle_end))
    if (( elapsed < COOLDOWN_SEC )); then
      sleep $((COOLDOWN_SEC - elapsed))
    fi
  fi

  if ! run_gas_guard; then
    if [[ "$GAS_GUARD_MODE" == "warn" ]]; then
      echo "gas guard warning: native balance below threshold (${GAS_GUARD_MIN_NATIVE}). continuing due BOT_GAS_GUARD_MODE=warn."
    else
      echo "gas guard stop: native balance below threshold (${GAS_GUARD_MIN_NATIVE}). bot loop halted."
      exit 10
    fi
  fi

  cycle_rounds="$ROUNDS"
  if (( MAX_TRADES_PER_CYCLE > 0 && cycle_rounds > MAX_TRADES_PER_CYCLE )); then
    cycle_rounds="$MAX_TRADES_PER_CYCLE"
  fi
  cycle_reverse_amount="$(randomized_reverse_amount "$REVERSE_AMOUNT" "$SIZE_JITTER_PCT")"

  set +e
  export OHLC_SEED_PRIVATE_KEY="$BOT_PRIVATE_KEY"
  OHLC_SEED_SYMBOLS="$SYMBOLS" \
  OHLC_SEED_ROUNDS="$cycle_rounds" \
  OHLC_SEED_SLIPPAGE_BPS="$SLIPPAGE_BPS" \
  OHLC_SEED_INCLUDE_REVERSE="true" \
  OHLC_SEED_REVERSE_MUSD_AMOUNT="$cycle_reverse_amount" \
  OHLC_SEED_STRICT="$STRICT" \
  "$SEED_WRAPPER" "$NETWORK"
  CODE=$?
  unset OHLC_SEED_PRIVATE_KEY
  set -e

  if [[ $CODE -ne 0 ]]; then
    failure_streak=$((failure_streak + 1))
    echo "market bot cycle failed (exit=$CODE). retrying in ${INTERVAL_SEC}s..."
    if (( failure_streak >= MAX_FAILURE_STREAK )); then
      echo "max failure streak reached (${failure_streak}). bot loop halted."
      exit 12
    fi
  else
    failure_streak=0
    echo "market bot cycle completed. rounds=${cycle_rounds} reverse_musd=${cycle_reverse_amount}"
  fi

  last_cycle_end="$(date +%s)"
  sleep_jitter=0
  if (( SLEEP_JITTER_SEC > 0 )); then
    sleep_jitter=$((RANDOM % (SLEEP_JITTER_SEC + 1)))
  fi
  sleep $((INTERVAL_SEC + sleep_jitter))
done
