#!/usr/bin/env bash
# restart.sh — 先停掉本仓库的实例，再用 start.sh 在后台重新拉起。
# 先确认要停的确实是本仓库的程序，确认不了就放弃，绝不按名字乱杀。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/state"

echo "Stopping this checkout's bridge instance (verified PID only)..."
if ! node scripts/stop-bridge-instance.mjs; then
  echo "Restart aborted: could not prove/stop the old instance. See messages above." >&2
  exit 1
fi

LOG="$ROOT/state/bridge-guard.log"
nohup bash "$ROOT/start.sh" >>"$LOG" 2>&1 &
guard=$!
echo "Guard started (PID $guard). Console log: state/bridge-guard.log"
echo "Stop it with: ./stop.sh"
