#!/usr/bin/env bash
# agent-panel 停止脚本
set -u
cd "$(dirname "$0")"

PID_FILE="agent-panel.pid"

stopped=0
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "停止 agent-panel pid=$PID ..."
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

# 兜底：清理残留进程
if pkill -f "node .*agent-panel/server/index.js" 2>/dev/null; then
  echo "已清理残留 agent-panel 进程"
  stopped=1
fi

if [ "$stopped" = "1" ]; then
  echo "agent-panel 已停止"
else
  echo "agent-panel 未在运行"
fi
