#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.atlas-route.pid"

if (( $# > 1 )); then
  echo "用法: $0 [端口]" >&2
  exit 2
fi

CURRENT_PORT=""
if [[ -f "$PID_FILE" ]]; then
  read -r CURRENT_PID CURRENT_PORT CURRENT_HOST < "$PID_FILE" || true
fi

APP_PORT="${1:-${MAP_STUDIO_PORT:-${CURRENT_PORT:-21990}}}"

if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
  echo "无效端口: $APP_PORT" >&2
  exit 2
fi

echo "正在重启虚拟示教平台服务（端口 ${APP_PORT}）..."
"$SCRIPT_DIR/stop.sh"
"$SCRIPT_DIR/start.sh" "$APP_PORT"
