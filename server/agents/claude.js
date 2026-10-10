// Claude Code 用量读取：{path}/projects/<项目>/<会话>.jsonl（以及 <会话>/subagents/*.jsonl）
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

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const MAX_FILES = 20000; // 防御：异常目录结构下不至于扫描失控
const SCAN_DEPTH = 4; // projects/<project>/<session>/subagents/*.jsonl

// 文件级缓存：path -> { mtimeMs, size, records }；文件未变则复用解析结果
const fileCache = new Map();

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 解析单个 JSONL 会话文件
async function parseSessionFile(filePath, fallbackSessionId, errors) {
  const records = [];
  const seen = new Set(); // 去重：message.id（回退 sessionId+timestamp+model）
  let sessionId = fallbackSessionId || '';
  let project = '';
  let title = '';
  let model = '';

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // 快速预过滤：绝大多数行不含 usage / summary / cwd
      if (!line.includes('"usage"') && !line.includes('"summary"') && !line.includes('"cwd"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.sessionId) sessionId = event.sessionId;
      if (event.cwd) project = event.cwd;
      if (event.type === 'summary' && !title && typeof event.summary === 'string') {
        title = event.summary.trim();
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
      const uncachedInput = nonNegative(usage.input_tokens);
      const output = nonNegative(usage.output_tokens);
      const input = uncachedInput + cacheRead; // 面板约定：input 含缓存读
      const total = input + cacheWrite + output;
      if (total <= 0) continue;

      const messageId = typeof event?.message?.id === 'string' ? event.message.id : '';
      const dedupeKey = messageId || `${sessionId}\u0000${event.timestamp}\u0000${modelId}\u0000${total}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (!model) model = modelId;
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
  return { records, project, title };
}

// 递归收集 *.jsonl（projects 下层级固定，限制深度防御异常结构）
function listJsonl(dir, depth, out) {
  if (depth > SCAN_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return out;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listJsonl(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

export async function readClaude(agent, errors) {
  const base = String(agent.path ?? '');
  // 允许 path 直接指向 projects 目录
  const projectsDir = basename(base) === 'projects' ? base : join(base, 'projects');
  if (!existsSync(projectsDir)) {
    errors.push({ file: projectsDir, message: 'Claude 数据目录不存在（应包含 projects/ 子目录）' });
    return { records: [] };
  }

  const files = listJsonl(projectsDir, 0, []);
  if (!files.length) {
    errors.push({ file: projectsDir, message: '未找到会话文件（projects/*/*.jsonl）' });
    return { records: [] };
  }

  const records = [];
  const pending = [];
  for (const file of files) {
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = statSync(file);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      continue;
    }
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      records.push(...cached.records);
      continue;
    }
    fileCache.delete(file);
    // 会话 id 兜底：文件名（<sessionId>.jsonl）；subagents 目录下的文件名不是会话 id
    const stem = basename(file, '.jsonl');
    const fallbackSessionId = /^[0-9a-f-]{36}$/i.test(stem) ? stem : basename(join(file, '..', '..'));
    pending.push(
      parseSessionFile(file, fallbackSessionId, errors)
        .then((parsed) => {
          fileCache.set(file, { mtimeMs, size, records: parsed.records });
          records.push(...parsed.records);
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
  return { records, files: files.length };
}
