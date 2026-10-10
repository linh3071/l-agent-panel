// Codex 用量读取器：state_5.sqlite 的 threads 表（会话级兜底）
// + sessions/**/rollout-*.jsonl 中的 token_count 事件（逐请求明细）。
//
// rollout 文件较大，首次查询会流式扫描（数秒），之后按文件 (mtime, size) 内存缓存，
// 改动文件才会重新解析；并发请求共享同一次扫描。

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { nonNegative, withSqlite } from './common.js';

const rolloutCache = new Map();
let inflightScan = null;

function listRolloutFiles(sessionsDir) {
  const files = [];
  let years = [];
  try {
    years = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name));
  } catch {
    return files;
  }
  for (const year of years) {
    const yearDir = join(sessionsDir, year.name);
    let months = [];
    try {
      months = readdirSync(yearDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const month of months) {
      const monthDir = join(yearDir, month.name);
      let days = [];
      try {
        days = readdirSync(monthDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const day of days) {
        const dayDir = join(monthDir, day.name);
        try {
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
              files.push(join(dayDir, entry.name));
            }
          }
        } catch {
          // 跳过不可读目录
        }
      }
    }
  }
  return files;
}

async function parseRollout(filePath) {
  const records = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = '';
  let provider = 'unknown';
  let cwd = '';
  let model = 'unknown';

  try {
    for await (const line of lines) {
      // 快速预过滤：绝大多数行是 response_item 等大对象，不包含我们需要的事件
      if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event?.payload;
      if (!payload) continue;
      if (event.type === 'session_meta') {
        sessionId = payload.session_id || sessionId;
        provider = payload.model_provider || provider;
        cwd = payload.cwd || cwd;
      } else if (event.type === 'turn_context') {
        if (payload.model) model = payload.model;
      } else if (event.type === 'event_msg' && payload.type === 'token_count') {
        const usage = payload.info?.last_token_usage;
        if (!usage) continue;
        const time = Date.parse(event.timestamp ?? '');
        if (!Number.isFinite(time)) continue;
        const input = nonNegative(usage.input_tokens);
        const output = nonNegative(usage.output_tokens);
        const cacheRead = nonNegative(usage.cached_input_tokens);
        const cacheWrite = nonNegative(usage.cache_write_input_tokens);
        const total = nonNegative(usage.total_tokens) || input + output + cacheRead + cacheWrite;
        if (total <= 0) continue;
        records.push({
          agent: null, // 由调用方填充
          provider,
          model,
          time,
          input,
          cacheRead,
          cacheWrite,
          output,
          total,
          sessionId,
          project: cwd,
        });
      }
    }
  } finally {
    stream.destroy();
  }
  return records;
}

async function scanCodexRollouts(agent, sessionsDir, errors) {
  const files = listRolloutFiles(sessionsDir);
  const parsed = new Map(); // filePath -> records
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
    const cached = rolloutCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      parsed.set(file, cached.records);
      continue;
    }
    rolloutCache.delete(file);
    pending.push(
      parseRollout(file)
        .then((records) => {
          rolloutCache.set(file, { mtimeMs, size, records });
          parsed.set(file, records);
        })
        .catch((error) => {
          if (errors.length < MAX_ERRORS) errors.push({ file, message: `解析失败：${error.message}` });
          parsed.set(file, []);
        }),
    );
  }
  await Promise.all(pending);
  return { files, parsed };
}

export async function readCodex(agent, errors) {
  const statePath = join(agent.path, 'state_5.sqlite');
  let threads = [];
  if (existsSync(statePath)) {
    try {
      threads = withSqlite(statePath, (db) =>
        db
          .prepare('SELECT id, rollout_path, created_at_ms, updated_at_ms, created_at, updated_at, model, model_provider, tokens_used, cwd, title FROM threads')
          .all(),
      );
    } catch (error) {
      errors.push({ file: statePath, message: `读取 threads 失败：${error.message}` });
    }
  } else {
    errors.push({ file: statePath, message: 'state_5.sqlite 不存在' });
  }

  const sessionsDir = join(agent.path, 'sessions');
  // 并发请求共享同一次扫描，避免重复解析 252MB 的 rollout 文件
  const scanKey = sessionsDir;
  const scanPromise =
    inflightScan?.key === scanKey ? inflightScan.promise : scanCodexRollouts(agent, sessionsDir, errors);
  inflightScan = { key: scanKey, promise: scanPromise };
  const { files, parsed } = await scanPromise;

  const produced = new Set(); // 已由 rollout 产出记录的 thread id
  const threadTitles = new Map(); // thread id -> title（rollout 记录也用它补标题）
  for (const thread of threads) {
    if (thread.title && thread.id) threadTitles.set(String(thread.id).toLowerCase(), thread.title);
  }
  const records = [];
  for (const [filePath, fileRecords] of parsed) {
    // rollout 文件名里的 uuid 即 thread id
    const base = basename(filePath);
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(base);
    if (match) produced.add(match[1].toLowerCase());
    for (const record of fileRecords) {
      record.agent = agent.name;
      if (!record.title) record.title = threadTitles.get(String(record.sessionId).toLowerCase()) || '';
      records.push(record);
    }
  }

  // 兜底：rollout 没有产出记录（或文件已缺失）的 thread，用 threads.tokens_used 生成单条记录
  for (const thread of threads) {
    const id = String(thread.id ?? '').toLowerCase();
    if (id && produced.has(id)) continue;
    const total = nonNegative(thread.tokens_used);
    if (total <= 0) continue;
    const time = Number(thread.updated_at_ms) || Number(thread.updated_at) * 1000 || Number(thread.created_at_ms) || Number(thread.created_at) * 1000;
    if (!Number.isFinite(time) || time <= 0) continue;
    records.push({
      agent: agent.name,
      provider: thread.model_provider || 'unknown',
      model: thread.model || 'unknown',
      time,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total,
      sessionId: thread.id,
      project: thread.cwd || '',
      title: thread.title || '',
    });
  }

  return { records, files: files.length };
}

