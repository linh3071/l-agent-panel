#!/usr/bin/env bash
# agent-panel 启动脚本（若已在运行则先停止旧进程，便于更新调试）
set -u
cd "$(dirname "$0")"

PID_FILE="agent-panel.pid"
LOG_DIR="logs"
HOST="127.0.0.1"
PORT="8787"

# 从 config.json 读取监听地址与端口（jq 不一定安装，用 node 解析）
if command -v node >/dev/null 2>&1; then
  CONFIG_PORT=$(node -e '
    try { const c = require("./config.json"); const p = Number(c?.server?.port); if (p > 0) console.log(p); }
    catch {}
  ' 2>/dev/null)
  [ -n "${CONFIG_PORT:-}" ] && PORT="$CONFIG_PORT"
  CONFIG_HOST=$(node -e '
    try { const c = require("./config.json"); if (c?.server?.host) console.log(c.server.host); }
    catch {}
  ' 2>/dev/null)
  [ -n "${CONFIG_HOST:-}" ] && HOST="$CONFIG_HOST"
fi

mkdir -p "$LOG_DIR"

# 端口探测统一用 curl（自带 --max-time 超时）。
# 不要用裸的 bash /dev/tcp：本机网络栈对 closed 端口的 connect 可能被丢弃，
# 裸 exec 3<>/dev/tcp/... 会无限阻塞导致脚本卡死。
port_listening() {
  curl -s --noproxy '*' --max-time 1 -o /dev/null "http://$1:$2/" 2>/dev/null
}

# 停止已有进程（重启语义）
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "停止旧进程 pid=$OLD_PID ..."
    kill "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# 若端口仍被占用（pid 文件丢失等场景），按命令行匹配清理
if port_listening "$HOST" "$PORT"; then
  echo "端口 $PORT 仍被占用，尝试按进程名清理 ..."
  pkill -f "node .*agent-panel/server/index.js" 2>/dev/null || true
  sleep 1
fi

echo "启动 agent-panel ..."
# NODE_USE_ENV_PROXY=1：让 Node 的 fetch 读取 HTTP(S)_PROXY 环境变量（本机走 7890 代理时必需）
# setsid：脱离当前会话，避免终端/父命令取消时连带杀掉服务
NODE_USE_ENV_PROXY=1 setsid nohup node server/index.js >> "$LOG_DIR/server.log" 2>&1 < /dev/null &
echo $! > "$PID_FILE"
NEW_PID=$(cat "$PID_FILE")
echo "pid=$NEW_PID，日志：$LOG_DIR/server.log"

# 等待服务就绪（每次探测最多 1 秒，总计有界）
for _ in $(seq 1 30); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "启动失败，最近日志："
    tail -n 20 "$LOG_DIR/server.log"
    rm -f "$PID_FILE"
    exit 1
  fi
  if port_listening "$HOST" "$PORT"; then
    echo ""
    echo "agent-panel 已启动：http://$HOST:$PORT"
    echo "调试：tail -f $LOG_DIR/server.log"
    exit 0
  fi
  sleep 0.2
done

echo "服务未及时就绪，请检查日志：tail -n 50 $LOG_DIR/server.log"
exit 1
