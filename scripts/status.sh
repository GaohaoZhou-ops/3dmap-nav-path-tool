#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.atlas-route.pid"
DEFAULT_PORT="${1:-${MAP_STUDIO_PORT:-21990}}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "服务未运行（默认地址 http://127.0.0.1:${DEFAULT_PORT}）"
  exit 3
fi

read -r SERVICE_PID APP_PORT < "$PID_FILE" || true
if [[ -z "${SERVICE_PID:-}" ]] || ! kill -0 "$SERVICE_PID" 2>/dev/null; then
  echo "服务未运行（发现过期 PID 文件）"
  exit 3
fi

SERVICE_COMMAND="$(ps -p "$SERVICE_PID" -o command= 2>/dev/null || true)"
if [[ "$SERVICE_COMMAND" != *"vite"* ]]; then
  echo "PID ${SERVICE_PID} 已被其他进程占用，未视为本项目服务" >&2
  exit 4
fi

if curl -fsS "http://127.0.0.1:${APP_PORT:-$DEFAULT_PORT}" >/dev/null 2>&1; then
  echo "服务运行正常: http://127.0.0.1:${APP_PORT:-$DEFAULT_PORT} (PID $SERVICE_PID)"
  exit 0
fi

echo "服务进程存在，但 HTTP 健康检查失败 (PID ${SERVICE_PID})" >&2
exit 1
