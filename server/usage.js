// 用量统计：参考 dsh-usage-stats（linh3071/l-dsh-plugins）
// 数据源：zcode（cli/db/db.sqlite 的 model_usage 表）、codex（state_5.sqlite 的 threads 表 + sessions/**/rollout-*.jsonl）

import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000; // UTC+8 日切分
const MAX_SESSION_ROWS = 10;
const MAX_ERRORS = 10;

// ---------- 工具 ----------

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 在只读数据库上执行 fn；打开或查询失败（如 /mnt/c 挂载上 WAL 的 disk I/O error）
// 时复制到临时目录重试，用完清理
function withSqlite(path, fn) {
  try {
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (error) {
      throw Object.assign(new Error(error.message), { openFailed: true });
    }
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (!error.openFailed && !/disk I\/O error|readonly|database is locked/i.test(error.message ?? '')) {
      throw error; // 查询逻辑错误（如表不存在），复制重试无意义
    }
    const copyPath = join(tmpdir(), `agent-panel-${randomUUID()}-${basename(path)}`);
    copyFileSync(path, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      try {
        if (statSync(path + suffix).size > 0) copyFileSync(path + suffix, copyPath + suffix);
      } catch {
        // wal/shm 不存在或不可读则忽略
      }
    }
    // 副本用读写模式打开：副本携带 wal 时，只读打开无法做 WAL 恢复
    const db = new DatabaseSync(copyPath);
    try {
      return fn(db);
    } finally {
      db.close();
      for (const p of [copyPath, copyPath + '-wal', copyPath + '-shm']) {
        try {
          unlinkSync(p);
        } catch {
          // 清理失败忽略
        }
      }
    }
  }
}

function emptyTotals() {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, sessions: 0 };
}

function addTo(totals, record) {
  totals.requests += 1;
  totals.input += record.input;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.output += record.output;
  totals.total += record.total;
}

// ---------- zcode 读取器 ----------

function readZcode(agent, errors) {
  const dbPath = join(agent.path, 'cli', 'db', 'db.sqlite');
  if (!existsSync(dbPath)) {
    errors.push({ file: dbPath, message: '数据库不存在' });
    return { records: [], aux: 0 };
  }

  try {
    return withSqlite(dbPath, (db) => {
      const directories = new Map();
      const titles = new Map();
      try {
        for (const row of db.prepare('SELECT id, directory, title FROM session').all()) {
          directories.set(row.id, row.directory);
          if (row.title) titles.set(row.id, row.title);
        }
      } catch {
        // session 表不可读时项目/标题列留空
      }

      const stmt = db.prepare(`
        SELECT session_id, query_source, provider_id, model_id, started_at,
               input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
        FROM model_usage
      `);
      const records = [];
      let aux = 0;
      for (const row of stmt.all()) {
        const input = nonNegative(row.input_tokens);
        const output = nonNegative(row.output_tokens);
        const cacheRead = nonNegative(row.cache_read_input_tokens);
        const cacheWrite = nonNegative(row.cache_creation_input_tokens);
        const total = nonNegative(row.computed_total_tokens) || input + output + cacheRead + cacheWrite;
        if (total <= 0) continue; // 过滤无 token 的取消请求
        const startedAt = Number(row.started_at);
        if (!Number.isFinite(startedAt)) continue;

        if (row.query_source === 'session_title') {
          aux += 1; // 标题生成请求不计入主统计（对齐参考实现）
          continue;
        }
        records.push({
          agent: agent.name,
          provider: row.provider_id || 'unknown',
          model: row.model_id || 'unknown',
          time: startedAt,
          input,
          cacheRead,
          cacheWrite,
          output,
          total,
          sessionId: row.session_id || '',
          project: directories.get(row.session_id) || '',
          title: titles.get(row.session_id) || '',
        });
      }
      return { records, aux };
    });
  } catch (error) {
    errors.push({ file: dbPath, message: `读取失败：${error.message}` });
    return { records: [], aux: 0 };
  }
}

// ---------- codex 读取器 ----------

// rollout 解析缓存：path -> { mtimeMs, size, records, error }
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

async function readCodex(agent, errors) {
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

// ---------- 聚合 ----------

function shanghaiDayIndex(time) {
  return Math.floor((time + SHANGHAI_OFFSET_MS) / DAY_MS);
}

function dayIndexToDate(index) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(index * DAY_MS - SHANGHAI_OFFSET_MS));
}

export async function queryUsage(agents, { from, to, groupBy }) {
  const startedAt = Date.now();
  const errors = [];
  let auxTitle = 0;
  const records = [];

  for (const agent of agents) {
    const type = String(agent.type ?? '').toLowerCase();
    if (type === 'zcode') {
      const { records: agentRecords, aux } = readZcode(agent, errors);
      auxTitle += aux;
      records.push(...agentRecords);
    } else if (type === 'codex') {
      const { records: agentRecords } = await readCodex(agent, errors);
      records.push(...agentRecords);
    } else {
      errors.push({ file: agent.path ?? '', message: `未知的 agent type：${type || '(空)'}` });
    }
  }

  const fromMs = Number.isFinite(Number(from)) ? Number(from) : null;
  const toMs = Number.isFinite(Number(to)) ? Number(to) : null;
  const filtered = records.filter((r) => (fromMs === null || r.time >= fromMs) && (toMs === null || r.time < toMs));

  // 热力图固定全量 365 天，不参与时间筛选
  const dayBuckets = new Map();
  for (const record of records) {
    const dayIndex = shanghaiDayIndex(record.time);
    dayBuckets.set(dayIndex, (dayBuckets.get(dayIndex) ?? 0) + record.total);
  }

  const totals = emptyTotals();
  const groups = new Map();
  const sessions = new Map();
  let coverageFrom = null;
  let coverageTo = null;

  for (const record of filtered) {
    addTo(totals, record);
    if (coverageFrom === null || record.time < coverageFrom) coverageFrom = record.time;
    if (coverageTo === null || record.time > coverageTo) coverageTo = record.time;

    const groupKey = groupBy === 'model' ? record.model : record.agent;
    let group = groups.get(groupKey);
    if (!group) {
      group = { key: groupKey, agent: record.agent, model: record.model, ...emptyTotals() };
      groups.set(groupKey, group);
    }
    addTo(group, record);

    if (record.sessionId) {
      const sessionKey = `${record.agent}\u0000${record.sessionId}`;
      let session = sessions.get(sessionKey);
      if (!session) {
        session = {
          agent: record.agent,
          id: record.sessionId,
          project: record.project,
          title: record.title || '',
          requests: 0,
          total: 0,
          models: new Map(),
        };
        sessions.set(sessionKey, session);
      }
      session.requests += 1;
      session.total += record.total;
      session.models.set(record.model, (session.models.get(record.model) ?? 0) + record.total);
      if (!session.project && record.project) session.project = record.project;
      if (!session.title && record.title) session.title = record.title;
    }
  }

  totals.sessions = sessions.size;
  const sortedGroups = [...groups.values()].sort((a, b) => b.total - a.total);
  for (const group of sortedGroups) {
    group.share = totals.total > 0 ? group.total / totals.total : 0;
  }

  const todayIndex = shanghaiDayIndex(Date.now());
  const days = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) {
    const index = todayIndex - i;
    days.push({ date: dayIndexToDate(index), total: dayBuckets.get(index) ?? 0 });
  }

  const topSessions = [...sessions.values()]
    .map((session) => {
      let bestModel = '';
      let bestTotal = -1;
      for (const [model, total] of session.models) {
        if (total > bestTotal) {
          bestModel = model;
          bestTotal = total;
        }
      }
      return {
        agent: session.agent,
        id: session.id,
        shortId: session.id.replace(/^session-/, '').slice(0, 8),
        project: session.project ? session.project.split('/').filter(Boolean).pop() || session.project : '',
        title: session.title || '',
        model: bestModel,
        requests: session.requests,
        total: session.total,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_SESSION_ROWS);

  const scanMs = Date.now() - startedAt;
  return {
    generatedAt: Date.now(),
    groupBy,
    range: { from: fromMs, to: toMs },
    totals,
    groups: sortedGroups,
    days,
    sessions: topSessions,
    meta: {
      errors: errors.slice(0, MAX_ERRORS),
      scanMs,
      coverage: { from: coverageFrom, to: coverageTo },
      aux: { titleRequests: auxTitle },
      recordCount: filtered.length,
    },
  };
}
