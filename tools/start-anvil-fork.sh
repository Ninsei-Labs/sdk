#!/usr/bin/env bash
# START A LOCAL ANVIL FORK AND LEAVE IT RUNNING FOR THE NEXT CI STEP.
#
# This is process orchestration, not SDK logic: start anvil, wait until its chain answers, keep the PID and log,
# and try the next public RPC when an endpoint refuses the state anvil needs. Keeping it here makes the workflow
# readable and lets the exact same script run on a developer machine.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/start-anvil-fork.sh --network <arbitrum-sepolia|ethereum-mainnet> [options]

Options:
  --network NAME       arbitrum-sepolia or ethereum-mainnet
  --port PORT          anvil port (default: 8545)
  --rpc URL            use this RPC; repeatable. Defaults are selected per network.
  --block-offset N     pin head - N on ethereum-mainnet (default: 5)
  -h, --help           show this help
EOF
}

NETWORK=""
PORT="8545"
BLOCK_OFFSET=""
RPC_URLS=()
while (($# > 0)); do
  case "$1" in
    --network) NETWORK="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --rpc) RPC_URLS+=("${2:-}"); shift 2 ;;
    --block-offset) BLOCK_OFFSET="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$NETWORK" in
  arbitrum-sepolia)
    CHAIN_ID="421614"
    BLOCK_OFFSET="${BLOCK_OFFSET:-0}"
    if ((${#RPC_URLS[@]} == 0)); then
      RPC_URLS+=("${RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}")
    fi
    PIN_BLOCK=0
    ;;
  ethereum-mainnet)
    CHAIN_ID="1"
    if ((${#RPC_URLS[@]} == 0)); then
      RPC_URLS+=(
        "${RPC_URL:-https://ethereum-rpc.publicnode.com}"
        "${FALLBACK_RPC_URL:-https://eth.drpc.org}"
        "https://eth.llamarpc.com"
        "https://1rpc.io/eth"
        "https://cloudflare-eth.com"
        "https://eth-mainnet.public.blastapi.io"
      )
    fi
    PIN_BLOCK=1
    BLOCK_OFFSET="${BLOCK_OFFSET:-5}"
    ;;
  *) echo "--network must be arbitrum-sepolia or ethereum-mainnet" >&2; usage >&2; exit 2 ;;
esac

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then echo "--port must be numeric" >&2; exit 2; fi
if [ -n "$BLOCK_OFFSET" ] && ! [[ "$BLOCK_OFFSET" =~ ^[0-9]+$ ]]; then
  echo "--block-offset must be numeric" >&2
  exit 2
fi

LOG="${TMPDIR:-/tmp}/anvil-$PORT.log"
PID_FILE="${TMPDIR:-/tmp}/anvil-$PORT.pid"
rm -f "$LOG" "$PID_FILE"

FORK_BLOCK=""
if ((PIN_BLOCK == 1)); then
  HEAD=""
  for url in "${RPC_URLS[@]}"; do
    [ -n "$url" ] || continue
    for _ in $(seq 1 30); do
      candidate="$(cast block-number --rpc-url "$url" 2>/dev/null | head -1 || true)"
      case "$candidate" in
        ''|*[!0-9]*) sleep 2 ;;
        *) HEAD="$candidate"; break ;;
      esac
    done
    [ -n "$HEAD" ] && break
  done
  if [ -z "$HEAD" ]; then
    echo "could not read a block number from any fork endpoint" >&2
    exit 1
  fi
  FORK_BLOCK=$((HEAD - BLOCK_OFFSET))
  if ((FORK_BLOCK < 1)); then FORK_BLOCK=1; fi
  echo "forking $NETWORK at block $FORK_BLOCK (head $HEAD)"
else
  echo "forking $NETWORK from the endpoint's latest state"
fi

for url in "${RPC_URLS[@]}"; do
  [ -n "$url" ] || continue
  echo "trying fork via $url"
  args=(
    --fork-url "$url"
    --fork-state-by-number
    --fork-retry-backoff 1000
    --retries 10
    --port "$PORT"
    --chain-id "$CHAIN_ID"
  )
  if [ -n "$FORK_BLOCK" ]; then args+=(--fork-block-number "$FORK_BLOCK"); fi
  nohup anvil "${args[@]}" > "$LOG" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    if cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      echo "$pid" > "$PID_FILE"
      echo "anvil is listening on 127.0.0.1:$PORT (pid $pid, log $LOG)"
      exit 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "fork via $url did not start:" >&2
  cat "$LOG" >&2
done

echo "could not start a $NETWORK fork from any endpoint" >&2
exit 1
