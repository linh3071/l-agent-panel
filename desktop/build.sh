#!/usr/bin/env bash
# 打包 Windows 便携版（绿色软件包）
#
# 产物：dist/agent-panel-portable/
#   Agent Panel.exe      启动器（Go 编译，无控制台窗口）
#   node/node.exe        内置 Node 运行时（v24，含 node:sqlite）
#   server/ web/         面板服务与前端
#   config.json          本地配置（由项目 config.json 生成，路径改写为 Windows 形式）
#   config.example.json  配置模板
#   使用说明.txt
#
# 用法：
#   ./desktop/build.sh          # 构建
#   ./desktop/build.sh --zip    # 构建并额外生成 zip
#
# 注意：产物中的 config.json 含各平台 API Key，请勿直接把该目录分享给他人。

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
GO_VERSION="${GO_VERSION:-1.24.5}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${CACHE_DIR:-$ROOT/desktop/.cache}"
DIST="$ROOT/dist/agent-panel-portable"
GO="$(command -v go || true)"

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$CACHE"

# ---------- 1. 准备 Node（Windows） ----------
NODE_EXE="$CACHE/node-$NODE_VERSION-win-x64/node.exe"
if [ ! -f "$NODE_EXE" ]; then
  ZIP="$CACHE/node-$NODE_VERSION-win-x64.zip"
  [ -f "$ZIP" ] || { log "下载 Node $NODE_VERSION (win-x64)"; curl -fL --progress-bar -o "$ZIP" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"; }
  log "解压 node.exe"
  python3 - "$ZIP" "$NODE_EXE" <<'PY'
import sys, zipfile, os, shutil
zip_path, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zip_path)
name = [n for n in z.namelist() if n.endswith('/node.exe')][0]
os.makedirs(os.path.dirname(out), exist_ok=True)
with z.open(name) as src, open(out, 'wb') as dst:
    shutil.copyfileobj(src, dst)
PY
fi

# ---------- 2. 准备 Go 并编译启动器 ----------
if [ -z "$GO" ]; then
  GO_DIR="$CACHE/go-$GO_VERSION"
  if [ ! -x "$GO_DIR/bin/go" ]; then
    TAR="$CACHE/go$GO_VERSION.linux-amd64.tar.gz"
    [ -f "$TAR" ] || { log "未安装 Go，下载 go$GO_VERSION"; curl -fL --progress-bar -o "$TAR" "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"; }
    log "解压 Go 工具链"
    mkdir -p "$GO_DIR"
    tar -xzf "$TAR" -C "$GO_DIR" --strip-components=1
  fi
  GO="$GO_DIR/bin/go"
fi
log "编译启动器（$("$GO" version | awk '{print $3}')）"
(cd "$ROOT/desktop/launcher" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  "$GO" build -trimpath -ldflags "-H windowsgui -s -w" -o "$DIST/Agent Panel.exe" .)

# ---------- 3. 组装目录 ----------
log "组装便携包目录"
mkdir -p "$DIST/node" "$DIST/server" "$DIST/web"
cp "$NODE_EXE" "$DIST/node/node.exe"
cp "$ROOT"/server/*.js "$DIST/server/"
cp "$ROOT"/web/* "$DIST/web/"
cp "$ROOT/config.example.json" "$ROOT/package.json" "$DIST/"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$DIST/"

# ---------- 4. 生成 Windows 版 config.json（路径改写 + 独立端口） ----------
# 独立端口：避免与 WSL 里的开发服务（默认 8787）冲突 —— 尤其在 WSL 为
# mirrored 网络模式（Windows 与 WSL 共享 localhost）时两者会同端口互斥。
PORTABLE_PORT="${PORT:-8790}"
if [ -f "$ROOT/config.json" ]; then
  log "从 config.json 生成便携版配置（路径改写为 C:\\ 与 UNC，端口 $PORTABLE_PORT）"
  DISTRO="$(wslpath -w / 2>/dev/null | sed -E 's#^\\\\wsl(\.localhost)?\\([^\\]+)\\.*#\2#')" || true
  [ -n "${DISTRO:-}" ] || DISTRO="Ubuntu-24.04"
  python3 - "$ROOT/config.json" "$DIST/config.json" "$DISTRO" "$PORTABLE_PORT" <<'PY'
import json, sys
src, out, distro, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

def to_windows(p):
    if not p.startswith('/'):
        return p
    parts = p.split('/')
    # /mnt/c/... -> C:\...
    if len(parts) > 3 and parts[1] == 'mnt' and len(parts[2]) == 1:
        return parts[2].upper() + ':' + '\\' + '\\'.join(parts[3:])
    # 其余 Linux 路径 -> \\wsl.localhost\<发行版>\...
    return '\\\\wsl.localhost\\' + distro + '\\' + '\\'.join(x for x in parts if x)

cfg = json.load(open(src, encoding='utf-8'))
cfg.setdefault('server', {})['host'] = '127.0.0.1'
cfg['server']['port'] = port
for agent in cfg.get('usage', {}).get('agents', []):
    agent['path'] = to_windows(agent.get('path', ''))
json.dump(cfg, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f'  监听: http://127.0.0.1:{port}')
print('  用量路径：')
for a in cfg.get('usage', {}).get('agents', []):
    print(f"    {a.get('name')}: {a.get('path')}")
PY
else
  log "未找到 config.json，便携包将使用 config.example.json（首次启动会自动复制，端口需自行设置）"
fi

# ---------- 5. 使用说明 ----------
cat > "$DIST/使用说明.txt" <<'TXT'
Agent Panel 便携版
==================

用法
----
双击「Agent Panel.exe」即可。面板会在一个独立窗口（Edge 应用模式）中打开，
打开后自动查询各平台额度；关闭窗口后所有相关进程都会退出，不驻留后台。

目录说明
--------
  Agent Panel.exe   启动器
  node\node.exe     内置 Node 运行时（无需另装 Node.js）
  server\ web\      面板服务与前端
  config.json       配置（各平台 API Key、用量数据路径）
  runtime\          运行时目录（Edge 配置、启动日志 launcher.log）
  logs\server.log   服务端日志

常见问题
--------
* 额度显示"缺少 apiKey 配置"：编辑 config.json 填入对应平台的 key。
* 用量 Tab 读不到 WSL 里的数据：确认 config.json 中路径为
  \\wsl.localhost\<发行版>\home\<用户>\... 形式，且 WSL 发行版名称正确。
* 预估费用是估算值：按 models.dev 单价 × 用量逐条计算，不含各平台峰谷价
  （如 DeepSeek 高峰时段翻倍）、折扣与赠送额度，也未换算汇率；实际扣费以各平台账单为准。
* 预估费用显示"—"或为空：价格表首次启动需联网拉取（缓存在 data\prices.json，
  12 小时后自动后台刷新）；离线不影响额度查询与用量统计。
* 打不开窗口：查看 runtime\launcher.log 与 logs\server.log。
* 想换端口：修改 config.json 的 server.port（启动器会自动跟随）。
  便携版默认 8790，避免与 WSL 里的开发服务（8787）冲突。

注意
----
config.json 内含各平台 API Key，请勿把整个目录分享给他人；
需要分享时请先删除 config.json（首次启动会用 config.example.json 重建）。
TXT

# ---------- 6. 结果 ----------
log "完成：$DIST"
du -sh "$DIST" 2>/dev/null || true
ls -1 "$DIST"

if [ "${1:-}" = "--zip" ] || [ "${1:-}" = "--release" ]; then
  ZIP_OUT="$ROOT/dist/agent-panel-portable.zip"
  log "打包 zip：$ZIP_OUT（不含 config.json / runtime / logs / data，可直接发布）"
  rm -f "$ZIP_OUT"
  if command -v zip >/dev/null 2>&1; then
    (cd "$ROOT/dist" && zip -qr "$ZIP_OUT" agent-panel-portable \
      -x 'agent-panel-portable/config.json' 'agent-panel-portable/runtime/*' 'agent-panel-portable/logs/*' 'agent-panel-portable/data/*')
  else
    # 无 zip 命令时用 python 打包（保留目录结构，排除本地敏感/运行时文件）
    python3 - "$ROOT/dist" "$ZIP_OUT" <<'PY'
import os, sys, zipfile
dist, out = sys.argv[1], sys.argv[2]
EXCLUDE_DIRS = {'runtime', 'logs', 'data'}
EXCLUDE_FILES = {'config.json'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(os.path.join(dist, 'agent-panel-portable')):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            if f in EXCLUDE_FILES:
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, dist))
PY
  fi
  du -sh "$ZIP_OUT"
  log "发布包内容校验："
  python3 - "$ZIP_OUT" <<'PY'
import sys, zipfile
names = zipfile.ZipFile(sys.argv[1]).namelist()
print(f"  共 {len(names)} 个条目")
bad = [n for n in names if n.endswith('config.json') or '/runtime/' in n or '/logs/' in n or '/data/' in n]
print("  !! 含本地敏感文件：" + str(bad) if bad else "  ✓ 未包含 config.json / runtime / logs / data")
PY
fi
