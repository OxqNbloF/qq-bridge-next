#!/usr/bin/env bash
# start.sh — 守护启动：程序退出后 5 秒自动重启。
# 如果已有实例在跑就直接退出；按 Ctrl+C 会先停掉程序再退出。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 收紧 state 目录的权限；失败只提醒，不影响启动。
node scripts/harden-state-acl.mjs --quiet || true

child=""
on_stop() {
  trap - INT TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap on_stop INT TERM

while :; do
  node "$ROOT/src/bridge.js" &
  child=$!
  wait "$child"
  code=$?
  child=""
  if [ "$code" -eq 2 ]; then
    echo "[$(date '+%F %T')] bridge already running in another window. Exiting."
    exit 2
  fi
  echo "[$(date '+%F %T')] bridge exited (code $code), restarting in 5 seconds..."
  sleep 5 || true
done
