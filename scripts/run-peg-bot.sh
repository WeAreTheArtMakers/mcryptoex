#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${PEG_BOT_NETWORK:-bscTestnet}"
INTERVAL_SEC="${PEG_BOT_INTERVAL_SEC:-35}"
STRICT="${PEG_BOT_STRICT:-false}"
DRY_RUN="${PEG_BOT_DRY_RUN:-false}"
SYMBOLS="${PEG_BOT_SYMBOLS:-USDC,USDT}"
BOT_PRIVATE_KEY="${PEG_BOT_PRIVATE_KEY:-}"
GAS_GUARD_MIN_NATIVE="${PEG_BOT_GAS_GUARD_MIN_NATIVE:-0.03}"
GAS_GUARD_MODE="$(echo "${PEG_BOT_GAS_GUARD_MODE:-stop}" | tr '[:upper:]' '[:lower:]')"
COOLDOWN_SEC="${PEG_BOT_COOLDOWN_SEC:-8}"
MAX_FAILURE_STREAK="${PEG_BOT_MAX_FAILURE_STREAK:-6}"
KILL_SWITCH_FILE="${PEG_BOT_KILL_SWITCH_FILE:-$ROOT_DIR/.peg-bot-kill-switch}"
CONTRACTS_DIR="$ROOT_DIR/packages/contracts"

if [[ "$GAS_GUARD_MODE" != "stop" && "$GAS_GUARD_MODE" != "warn" ]]; then
  echo "unsupported PEG_BOT_GAS_GUARD_MODE=$GAS_GUARD_MODE (allowed: stop|warn)"
  exit 1
fi

if [[ "$NETWORK" != "bscTestnet" && "$NETWORK" != "sepolia" ]]; then
  echo "unsupported PEG_BOT_NETWORK=$NETWORK (allowed: bscTestnet|sepolia)"
  exit 1
fi

if ! [[ "$COOLDOWN_SEC" =~ ^[0-9]+$ && "$MAX_FAILURE_STREAK" =~ ^[0-9]+$ ]]; then
  echo "cooldown/failure values must be integer."
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

echo "peg bot loop started network=${NETWORK} symbols=${SYMBOLS} interval=${INTERVAL_SEC}s gas_guard_min=${GAS_GUARD_MIN_NATIVE} mode=${GAS_GUARD_MODE} kill_switch=${KILL_SWITCH_FILE}"

last_cycle_end=0
failure_streak=0

while true; do
  if kill_switch_on; then
    echo "kill switch active at ${KILL_SWITCH_FILE}; peg bot halted."
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
      echo "gas guard warning: native balance below threshold (${GAS_GUARD_MIN_NATIVE}). continuing due PEG_BOT_GAS_GUARD_MODE=warn."
    else
      echo "gas guard stop: native balance below threshold (${GAS_GUARD_MIN_NATIVE}). peg bot halted."
      exit 10
    fi
  fi

  set +e
  EXTRA_ENV=(
    "PEG_STRICT=${STRICT}"
    "PEG_DRY_RUN=${DRY_RUN}"
    "PEG_SYMBOLS=${SYMBOLS}"
  )
  if [[ -n "$BOT_PRIVATE_KEY" ]]; then
    EXTRA_ENV+=("PRIVATE_KEY=${BOT_PRIVATE_KEY}")
  fi
  "$ROOT_DIR/scripts/with-resolved-rpc.sh" "$NETWORK" env "${EXTRA_ENV[@]}" npm --prefix "$CONTRACTS_DIR" run "peg:stabilize:${NETWORK}"
  CODE=$?
  set -e

  if [[ $CODE -ne 0 ]]; then
    failure_streak=$((failure_streak + 1))
    echo "peg bot cycle failed (exit=$CODE). retrying in ${INTERVAL_SEC}s..."
    if (( failure_streak >= MAX_FAILURE_STREAK )); then
      echo "max failure streak reached (${failure_streak}). peg bot loop halted."
      exit 12
    fi
  else
    failure_streak=0
    echo "peg bot cycle completed."
  fi

  last_cycle_end="$(date +%s)"
  sleep "$INTERVAL_SEC"
done
