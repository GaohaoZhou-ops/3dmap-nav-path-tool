#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.atlas-route.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "服务未运行"
  exit 0
fi

read -r SERVICE_PID APP_PORT BIND_HOST < "$PID_FILE" || true
if [[ -z "${SERVICE_PID:-}" ]] || ! kill -0 "$SERVICE_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "服务未运行，已清理过期状态"
  exit 0
fi

SERVICE_COMMAND="$(ps -p "$SERVICE_PID" -o command= 2>/dev/null || true)"
if [[ "$SERVICE_COMMAND" != *"vite"* ]]; then
  echo "拒绝终止 PID ${SERVICE_PID}：它不是本项目的 Vite 服务" >&2
  exit 4
fi

kill "$SERVICE_PID"
for _ in {1..40}; do
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "服务已终止（端口 ${APP_PORT:-21990}）"
    exit 0
  fi
  sleep 0.1
done

kill -9 "$SERVICE_PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "服务已强制终止（端口 ${APP_PORT:-21990}）"
