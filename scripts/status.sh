#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.atlas-route.pid"
DEFAULT_PORT="${1:-${MAP_STUDIO_PORT:-21990}}"

source "$SCRIPT_DIR/network-info.sh"

if [[ ! -f "$PID_FILE" ]]; then
  echo "服务未运行（默认端口 ${DEFAULT_PORT}，启动后允许局域网访问）"
  exit 3
fi

read -r SERVICE_PID APP_PORT BIND_HOST < "$PID_FILE" || true
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
  if atlas_command_is_loopback_only "$SERVICE_COMMAND" "${BIND_HOST:-}"; then
    echo "服务运行正常，但当前进程只监听本机回环地址 (PID $SERVICE_PID)"
    echo "要允许其他设备访问，请在合适时机停止并重新启动服务"
    exit 0
  fi
  echo "服务运行正常并允许网络访问 (PID $SERVICE_PID)"
  atlas_print_access_urls "${APP_PORT:-$DEFAULT_PORT}" "${BIND_HOST:-0.0.0.0}"
  exit 0
fi

echo "服务进程存在，但 HTTP 健康检查失败 (PID ${SERVICE_PID})" >&2
exit 1
