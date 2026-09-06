#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PORT="${1:-${MAP_STUDIO_PORT:-21990}}"
PID_FILE="$PROJECT_DIR/.atlas-route.pid"
LOG_FILE="$PROJECT_DIR/.atlas-route.log"
VITE_BIN="$PROJECT_DIR/node_modules/.bin/vite"

if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
  echo "无效端口: $APP_PORT" >&2
  exit 2
fi

if [[ ! -x "$VITE_BIN" ]]; then
  echo "依赖尚未安装，请先在项目目录执行: npm install" >&2
  exit 2
fi

if [[ -f "$PID_FILE" ]]; then
  read -r EXISTING_PID EXISTING_PORT < "$PID_FILE" || true
  if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    EXISTING_COMMAND="$(ps -p "$EXISTING_PID" -o command= 2>/dev/null || true)"
    if [[ "$EXISTING_COMMAND" == *"vite"* ]]; then
      echo "服务已运行: http://127.0.0.1:${EXISTING_PORT:-$APP_PORT} (PID $EXISTING_PID)"
      exit 0
    fi
  fi
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $APP_PORT 已被其他进程占用" >&2
  exit 1
fi

cd "$PROJECT_DIR"
nohup "$VITE_BIN" --host 127.0.0.1 --port "$APP_PORT" --strictPort >"$LOG_FILE" 2>&1 &
SERVICE_PID=$!
printf '%s %s\n' "$SERVICE_PID" "$APP_PORT" > "$PID_FILE"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1; then
    echo "服务已启动: http://127.0.0.1:$APP_PORT (PID $SERVICE_PID)"
    echo "日志文件: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo "服务启动失败，请查看日志: $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.2
done

echo "服务仍在启动中，请运行 scripts/status.sh 检查状态" >&2
exit 1
