// Claude Code 用量读取器：{path}/projects/<项目>/<会话>.jsonl（以及 <会话>/subagents/*.jsonl）
//
// 数据格式依据 ccusage 的 claude 适配器（rust/adapters/claude）：
//   - 每行一个 JSON 事件；用量在 type=assistant 事件的 message.usage
//   - usage.input_tokens 不含缓存读写，缓存需另加：
//       cache_read_input_tokens（读）、cache_creation_input_tokens（写）
//   - 去重：同一个 API 响应（message.id 相同）可能被记录多次（如 sidechain 回放），只计一次
//   - 跳过 isApiErrorMessage 与 model 为 <synthetic> 的条目（非真实 API 调用）
//
// 口径换算到面板约定（input 含缓存读）：
//   input = usage.input_tokens + cache_read_input_tokens
//   total = input + cache_creation_input_tokens + output

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { nonNegative, walkFiles, statSafe, createRecordCache, parseLine } from './common.js';

const SCAN_DEPTH = 4; // projects/<project>/<session>/subagents/*.jsonl
const fileCache = createRecordCache();

// 解析单个 JSONL 会话文件
function parseSessionFile(filePath, fallbackSessionId) {
  return new Promise((resolve) => {
    const records = [];
    const seen = new Set(); // 去重：message.id（回退 sessionId+timestamp+model+total）
    let sessionId = fallbackSessionId || '';
    let project = '';
    let title = '';

    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    (async () => {
      try {
        for await (const line of lines) {
          // 快速预过滤：绝大多数行不含 usage / summary / cwd
          if (!line.includes('"usage"') && !line.includes('"summary"') && !line.includes('"cwd"')) continue;
          const event = parseLine(line);
          if (!event || typeof event !== 'object') continue;

          if (event.sessionId) sessionId = event.sessionId;
          if (event.cwd) project = event.cwd;
          if (event.type === 'summary') {
            if (!title && typeof event.summary === 'string') title = event.summary.trim();
            continue;
          }

          const usage = event?.message?.usage;
          if (!usage) continue;
          if (event.isApiErrorMessage === true) continue; // 错误消息不产生用量
          const modelId = typeof event?.message?.model === 'string' ? event.message.model : '';
          if (!modelId || modelId.startsWith('<')) continue; // <synthetic> 等本地消息
          const time = Date.parse(event.timestamp ?? event?.message?.created_at ?? '');
          if (!Number.isFinite(time)) continue;

          const cacheRead = nonNegative(usage.cache_read_input_tokens);
          const cacheWrite = nonNegative(usage.cache_creation_input_tokens);
          const input = nonNegative(usage.input_tokens) + cacheRead; // 面板约定：input 含缓存读
          const output = nonNegative(usage.output_tokens);
          const total = input + cacheWrite + output;
          if (total <= 0) continue;

          const messageId = typeof event?.message?.id === 'string' ? event.message.id : '';
          const dedupeKey = messageId || `${sessionId}\u0000${event.timestamp}\u0000${modelId}\u0000${total}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          records.push({
            agent: null, // 调用方填充
            provider: 'anthropic',
            model: modelId,
            time,
            input,
            cacheRead,
            cacheWrite,
            output,
            total,
            sessionId,
            project,
            title,
          });
        }
      } finally {
        stream.destroy();
      }
      resolve({ records });
    })();
  });
}

export async function readClaude(agent, errors) {
  const base = String(agent.path ?? '');
  // 允许 path 直接指向 projects 目录
  const projectsDir = basename(base) === 'projects' ? base : join(base, 'projects');
  if (!existsSync(projectsDir)) {
    errors.push({ file: projectsDir, message: 'Claude 数据目录不存在（应包含 projects/ 子目录）' });
    return { records: [], aux: 0 };
  }

  const files = walkFiles(projectsDir, { depth: SCAN_DEPTH, match: (name) => name.endsWith('.jsonl') });
  if (!files.length) {
    errors.push({ file: projectsDir, message: '未找到会话文件（projects/*/*.jsonl）' });
    return { records: [], aux: 0 };
  }

  const records = [];
  const pending = [];
  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const cached = fileCache.get(file, stat);
    if (cached) {
      records.push(...cached);
      continue;
    }
    // 会话 id 兜底：文件名（<sessionId>.jsonl）；subagents 目录下的文件名不是会话 id
    const stem = basename(file, '.jsonl');
    const fallbackSessionId = /^[0-9a-f-]{36}$/i.test(stem) ? stem : basename(join(file, '..', '..'));
    pending.push(
      parseSessionFile(file, fallbackSessionId)
        .then(({ records: parsed }) => {
          fileCache.put(file, stat, parsed);
          records.push(...parsed);
        })
        .catch((error) => {
          errors.push({ file, message: `解析失败：${error.message}` });
        }),
    );
  }
  await Promise.all(pending);

  // 标题只在会话主文件里有（summary 行），subagent 文件继承同会话标题
  const titles = new Map();
  for (const record of records) {
    if (record.title && record.sessionId) titles.set(record.sessionId, record.title);
  }
  for (const record of records) {
    record.agent = agent.name;
    if (!record.title && record.sessionId) record.title = titles.get(record.sessionId) || '';
  }
  return { records, aux: 0 };
}
