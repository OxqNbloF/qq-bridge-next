#!/usr/bin/env bash
# stop.sh — 只停本仓库的 qq-bridge 实例（先核对进程号和控制台端口）。
# 同时会停掉 start.sh 的守护循环，避免它把实例拉回来。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec node "$ROOT/scripts/stop-bridge-instance.mjs" "$@"
