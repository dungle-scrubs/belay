#!/usr/bin/env bash
# End-to-end lease test: start two hosts on one session with fast lease timings,
# confirm exactly one answers a turn, then kill the leader and confirm the
# standby takes over and answers. Run from anywhere: bash scripts/verify-lease-e2e.sh
set -uo pipefail
cd "$(dirname "$0")/.." # apps/agent-host

BASE=${RICHTER_URL:-http://localhost:3025}
SID=$(curl -sS -X POST "$BASE/sessions" -H 'content-type: application/json' -d '{}' | grep -oE 'sess_[a-f0-9-]+' | head -1)
WS=$(mktemp -d /tmp/trevor-lease-ws.XXXXXX)
LOGA=$(mktemp /tmp/trevor-lease-A.XXXXXX.log)
LOGB=$(mktemp /tmp/trevor-lease-B.XXXXXX.log)
echo "session=$SID workspace=$WS"

start_host() { # $1=logfile -> prints pid
  env SESSION_ID="$SID" TREVOR_WORKSPACE="$WS" \
    LEASE_HEARTBEAT_MS=700 LEASE_PROBE_MS=900 LEASE_TTL_MS=3000 LEASE_SETTLE_MS=2500 \
    pnpm --filter @trevor/agent-host start >"$1" 2>&1 &
  echo $!
}

kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
}

last_role() { grep "lease:" "$1" 2>/dev/null | tail -1; }

cleanup() {
  kill_tree "${PIDA:-0}" 2>/dev/null
  kill_tree "${PIDB:-0}" 2>/dev/null
  rm -rf "$WS" "$LOGA" "$LOGB"
}
trap cleanup EXIT

PIDA=$(start_host "$LOGA")
PIDB=$(start_host "$LOGB")

echo "waiting for lease to settle (one leader, one standby)..."
SETTLED=0
for _ in $(seq 1 40); do
  ra=$(last_role "$LOGA"); rb=$(last_role "$LOGB")
  if { echo "$ra" | grep -q leader && echo "$rb" | grep -q standby; } ||
    { echo "$ra" | grep -q standby && echo "$rb" | grep -q leader; }; then
    SETTLED=1
    echo "settled: A=[$ra] B=[$rb]"
    break
  fi
  sleep 0.5
done
[ "$SETTLED" = 1 ] || { echo "FAIL: lease did not settle to one leader + one standby"; exit 1; }

echo "=== phase 1: two hosts up, one turn -> exactly one answer ==="
SESSION_ID="$SID" WINDOW_MS=15000 node scripts/verify-lease.mjs || exit 1

if last_role "$LOGA" | grep -q leader; then
  LEADER_PID=$PIDA; OTHER_LOG=$LOGB; echo "leader = host A"
else
  LEADER_PID=$PIDB; OTHER_LOG=$LOGA; echo "leader = host B"
fi
echo "killing the leader (pid $LEADER_PID)..."
kill_tree "$LEADER_PID"

echo "waiting for the standby to take over..."
TOOK_OVER=0
for _ in $(seq 1 30); do
  if last_role "$OTHER_LOG" | grep -q leader; then
    TOOK_OVER=1
    echo "takeover: $(last_role "$OTHER_LOG")"
    break
  fi
  sleep 0.5
done
[ "$TOOK_OVER" = 1 ] || { echo "FAIL: standby did not take over after leader death"; exit 1; }

echo "=== phase 2: after leader death, the survivor answers ==="
SESSION_ID="$SID" WINDOW_MS=15000 node scripts/verify-lease.mjs || exit 1

echo "LEASE-E2E ALL PASS"
