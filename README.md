<img src="desktop/logo/logo-256.png" width="72" alt="Agent Panel logo">

# Agent Panel

本地 Agent 面板网站：**限额查询** + **用量统计** 两个 Tab。

参考实现：[linh3071/l-dsh-plugins](https://github.com/linh3071/l-dsh-plugins) 中的 `dsh-quota-dashboard` 与 `dsh-usage-stats`。

- 零依赖：Node.js（≥ 22.5，需内置 `node:sqlite`）+ 原生前端，无需 `npm install`
- 配置热加载：修改 `config.json` 后无需重启，下次请求即生效

## 启动 / 停止

```bash
./start.sh    # 启动（已在运行则自动重启，便于更新调试）
./stop.sh     # 停止
```

启动后访问 <http://127.0.0.1:8787>（端口在 `config.json` 的 `server.port` 修改）。

> 说明：脚本启动时设置了 `NODE_USE_ENV_PROXY=1`，使 Node 的 fetch 读取
> `HTTP(S)_PROXY` 环境变量；若手动 `node server/index.js` 调试且外网需要代理，
> 请同样带上该变量：`NODE_USE_ENV_PROXY=1 node server/index.js`。

调试日志：`tail -f logs/server.log`

## Windows 便携版（exe 绿色包）

不想开终端时，可以打包成 Windows 便携版：**双击 exe 打开面板窗口，打开即自动查询额度；
关闭窗口后所有进程退出，不驻留后台。**

```bash
./desktop/build.sh          # 构建到 dist/agent-panel-portable/
./desktop/build.sh --zip    # 额外生成 zip
```

产物结构（约 96MB，其中主要是内置的 Node 运行时）：

| 路径 | 说明 |
|---|---|
| `Agent Panel.exe` | 启动器（Go 编译，GUI 子系统，无控制台窗口；图标见 `desktop/logo/`） |
| `node/node.exe` | 内置 Node 运行时，无需另装 Node.js |
| `server/` `web/` | 面板服务与前端 |
| `config.json` | 由项目 config.json 生成：`/mnt/c/...` 改写为 `C:\...`，`/home/...` 改写为 `\\wsl.localhost\<发行版>\...` |
| `runtime/` | 启动日志 `launcher.log`、Edge 专用配置目录 |

图标：启动器图标由 `desktop/logo/logo.ico` 经 `rsrc` 编译成 `desktop/launcher/rsrc_windows_amd64.syso`
（已入库，`go build` 会自动链接）；窗口/任务栏图标来自页面 `web/favicon.ico`。改动 logo 后重新生成：

```bash
# 首次：安装依赖（Pillow 用于画图，rsrc 用于生成 exe 图标资源）
python3 -m venv /tmp/imgvenv && /tmp/imgvenv/bin/pip install pillow
GOBIN="$PWD/desktop/.cache/gobin" desktop/.cache/go-1.24.5/bin/go install github.com/akavel/rsrc@latest

# 重新生成 favicon.ico / logo.svg / logo-256.png / logo.ico
/tmp/imgvenv/bin/python desktop/make-logo.py

# 重新生成 exe 图标资源，然后重新打包
desktop/.cache/gobin/rsrc -ico desktop/logo/logo.ico -o desktop/launcher/rsrc_windows_amd64.syso
./desktop/build.sh
```

实现要点：

- 界面用系统自带 Edge 的 `--app` 应用模式（独立进程 + 独立配置目录，无地址栏，不碰用户浏览器配置）；找不到 Edge 时退回默认浏览器
- 启动器负责拉起/收尾：窗口关闭即结束 node 进程（`taskkill /T /F`）
- **兜底**：页面每 5s 上报一次 `/api/ping` 心跳，服务端在心跳停止 `AGENT_PANEL_IDLE_EXIT_SECONDS` 秒
  （便携版为 20s）后自行退出。因此即使启动器被强杀、浏览器崩溃或窗口被移交给别的实例，
  也不会有残留服务进程（常驻模式 `start.sh` 不设该变量，行为不变）
- 便携版默认端口 **8790**（避免与 WSL 中的开发服务 8787 冲突；WSL 为 mirrored 网络模式时
  两者共享 localhost、会同端口互斥），可用 `PORT=xxxx ./desktop/build.sh` 或改 config.json 调整
- 若已有一个面板实例在运行（含 WSL 里的开发服务），启动器只开窗不重复启动服务

> 注意：便携包内的 `config.json` 含各平台 API Key，请勿直接分享整个目录；
> 需要分享时先删除该文件（首次启动会用 `config.example.json` 重建）。

## 配置说明（config.json）

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "quota": {
    "providers": [
      // platform 支持：deepseek | minimax | glm | sub2api
      { "id": "deepseek", "platform": "deepseek", "apiKey": "..." },
      { "id": "sub2api", "platform": "sub2api", "baseURL": "https://...", "apiKey": "..." }
    ]
  },
  "usage": {
    "agents": [
      // type 支持：zcode | codex；name 即统计时的 Agent 名（可随意改）
      { "name": "ZCode (Windows)", "type": "zcode", "path": "/mnt/c/Users/joint/.zcode" },
      { "name": "ZCode (WSL)", "type": "zcode", "path": "/home/joint/.zcode" },
      { "name": "Codex (WSL)", "type": "codex", "path": "/home/joint/.codex" }
    ]
  }
}
```

模板见 `config.example.json`。

## 限额 Tab

并发查询各平台额度，展示摘要行与明细表，支持单卡刷新 / 全部刷新、点击卡片展开详情：

| 平台 | 接口 | 说明 |
|---|---|---|
| DeepSeek | `GET /user/balance` | 账户余额（人民币/美元） |
| MiniMax | `GET /v1/token_plan/remains` | 各模型 5 小时 / 7 天窗口余量 |
| GLM | `GET /api/monitor/usage/quota/limit` | 本周 / 5 小时窗口额度、联网搜索等月度次数 |
| Sub2API | `GET {baseURL}/v1/usage` | 总额度、限流窗口、近 30 天用量与费用 |

使用率配色：≥ 80% 黄色、≥ 100% 红色。

## 用量 Tab

按 **Agent**（config 中的 `name`，WSL 与 Windows 视为两个 Agent）或**模型**分组，支持 今天 / 7 天 / 30 天 / 自定义 时间范围：

- 汇总卡片（一行 4 个）：请求数、会话数、缓存命中率、总 Tokens、输入/输出、缓存读/写
- **预估费用**：汇总卡片 + 分组表格 + 会话 Top 10 各有一列费用（美元，按 models.dev 价格表估算，见下）
- 分组表格与占比进度条
- 近 365 天 GitHub 风格热力图（UTC+8 日切分，置顶显示、含月份/周坐标轴，不受筛选条件影响）
- 会话 Top 10（Agent、标题、项目、主模型、请求数、Tokens、费用）

### 预估费用与价格表

价格来自 [models.dev](https://models.dev)（`api.json`，含 input / output / cache_read / cache_write 四个价位，
美元/百万 token），逐条请求计价后累加：

- 未缓存输入 = 输入总量 − 缓存读（本项目各来源的 `input_tokens` 均含缓存读）
- 模型匹配顺序：对应 provider 内精确 → 全局精确 → 归一化（忽略大小写与分隔符）→ 最长前缀近似
  （如 `MiniMax-M2.7-highspeed` → `MiniMax-M2.7`）；未匹配的模型按 $0 计并在底部提示
- DeepSeek 峰谷价：北京时间工作日 9:00–12:00、14:00–18:00 价格翻倍（法定节假日不判断，属已知近似），
  可在 `config.json` 的 `usage.price.peak` 调整或关掉

**更新时机**（价格可能随时变更，采用 stale-while-revalidate）：

| 时机 | 行为 |
|---|---|
| 服务启动 | 缓存缺失或超过 TTL（默认 12h）→ 后台拉取，不阻塞启动 |
| 每次用量查询 | 同样判断；过期则后台刷新 —— **本次查询用旧表、下次查询用新表，查询永不被网络阻塞** |
| 手动 | 用量 Tab 底部「刷新价格」按钮 → `POST /api/price/refresh` 强制拉取 |
| 拉取失败 | 保留旧表继续计价，错误显示在底部，且 10 分钟内不自动重试（避免每次查询都打网络） |
| 并发 | 同一时刻只允许一个拉取在途（单飞） |

缓存落在 `data/prices.json`（原子写入，避免读到半截文件）。配置见 `config.example.json` 的 `usage.price`，
`enabled: false` 可完全关闭费用估算。

### 数据来源

| type | 读取内容 |
|---|---|
| `zcode` | `{path}/cli/db/db.sqlite` 的 `model_usage` 表（每请求一条：模型、token 明细、时间戳）。Windows 挂载（/mnt/c）打开失败时自动复制到临时目录再读 |
| `codex` | `{path}/state_5.sqlite` 的 `threads` 表（会话级兜底）+ `{path}/sessions/**/rollout-*.jsonl` 中的 `token_count` 事件（逐请求明细） |

说明：

- Codex rollout 文件较大，首次查询会流式扫描（数秒），之后按文件 `(mtime, size)` 内存缓存，改动文件才会重新解析；重启服务后缓存清空
- ZCode 中 `query_source='session_title'` 的标题生成请求不计入主统计，仅在底部 meta 中显示
- Codex 会话若 rollout 中没有 `token_count` 事件，则回退使用 `threads.tokens_used` 的会话总量（时间记为最后更新时间，token 明细不可拆分）

## API

```
POST /api/quota/query   { "key": "deepseek" }   # key 省略则查询全部
POST /api/usage/query   { "from": 0, "to": 0, "groupBy": "agent" | "model" }
POST /api/price/refresh                          # 强制刷新价格表，返回最新状态
GET  /api/ping                                   # 心跳（便携版据此判断窗口是否关闭）
```

时间戳为毫秒，`from` 闭区间、`to` 开区间。
