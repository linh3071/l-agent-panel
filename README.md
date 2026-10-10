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
- 分组表格与占比进度条
- 近 365 天 GitHub 风格热力图（UTC+8 日切分，置顶显示、含月份/周坐标轴，不受筛选条件影响）
- 会话 Top 10（Agent、标题、项目、主模型、请求数、Tokens）

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
```

时间戳为毫秒，`from` 闭区间、`to` 开区间。
