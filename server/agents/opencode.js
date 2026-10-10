// OpenCode 用量读取器。
//
// 数据目录（config 的 path 指向它，通常是 ~/.local/share/opencode）：
//   1) opencode.db（SQLite）：
//        session_message 表（id, session_id, type, data JSON, time_created[, seq]），data 为消息 JSON；
//        session / session_v2 表为会话级汇总（仅在缺少 session_message 时兜底使用）
//   2) 旧版文件：storage/message/<会话ID>/<消息ID>.json，内容同样是消息 JSON
//
// 消息 JSON：{ id, sessionID, providerID, modelID, time: { created },
//             tokens: { input, output, reasoning, cache: { read, write } }, cost }
//
// 口径：tokens.input 不含缓存读（与 opencode 自身计价一致），
//       换算为面板口径：input = tokens.input + cache.read，total = input + cache.write + output。
// 自带 cost 字段为 opencode 自己的估算，这里忽略（统一以 models.dev 为准）。

import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { nonNegative, withSqlite, tableColumns, hasTable, walkFiles, statSafe, createRecordCache, parseLine, toEpochMs } from './common.js';

const fileCache = createRecordCache();

// 消息 JSON → 面板记录
function recordFromMessage(message, fallback = {}) {
  const tokens = message?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;

  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const cacheRead = nonNegative(cache.read);
  const cacheWrite = nonNegative(cache.write);
  const uncachedInput = nonNegative(tokens.input);
  const output = nonNegative(tokens.output);
  const input = uncachedInput + cacheRead; // 面板约定：input 含缓存读
  const total = input + cacheWrite + output;
  if (total <= 0) return null;

  const time = toEpochMs(message.time?.created) ?? toEpochMs(fallback.timeCreated);
  if (!Number.isFinite(time)) return null;

  return {
    agent: null,
    provider: typeof message.providerID === 'string' && message.providerID ? message.providerID : 'unknown',
    model: typeof message.modelID === 'string' && message.modelID ? message.modelID : 'unknown',
    time,
    input,
    cacheRead,
    cacheWrite,
    output,
    total,
    sessionId: String(message.sessionID ?? fallback.sessionId ?? ''),
    project: typeof message.path?.cwd === 'string' ? message.path.cwd : '',
    title: '',
  };
}

// SQLite：优先 session_message（逐消息），退化到 session / session_v2（会话级汇总）
function readDatabase(dbPath, errors) {
  return withSqlite(dbPath, (db) => {
    const records = [];
    let source = '';

    if (hasTable(db, 'session_message')) {
      const columns = tableColumns(db, 'session_message');
      const hasTime = columns.has('time_created');
      const sql = `SELECT id, session_id, data${hasTime ? ', time_created' : ''} FROM session_message`;
      let rows = [];
      try {
        rows = db.prepare(sql).all();
      } catch (error) {
        errors.push({ file: dbPath, message: `读取 session_message 失败：${error.message}` });
      }
      const seen = new Set();
      for (const row of rows) {
        const message = typeof row.data === 'string' ? parseLine(row.data) : row.data;
        if (!message || typeof message !== 'object') continue;
        const key = String(message.id ?? row.id ?? '');
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const record = recordFromMessage(message, { sessionId: row.session_id, timeCreated: row.time_created });
        if (record) records.push(record);
      }
      if (records.length) source = 'session_message';
    }

    if (!records.length) {
      // 会话级汇总兜底：无法拆分到逐请求，时间取会话创建时间
      for (const table of ['session_v2', 'session']) {
        if (!hasTable(db, table)) continue;
        const columns = tableColumns(db, table);
        if (!['id', 'time_created', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write'].every((c) => columns.has(c))) continue;
        let rows = [];
        try {
          rows = db.prepare(`SELECT id, time_created, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, ${columns.has('model') ? 'model' : 'NULL'} FROM ${table}`).all();
        } catch (error) {
          errors.push({ file: dbPath, message: `读取 ${table} 失败：${error.message}` });
          continue;
        }
        for (const row of rows) {
          const cacheRead = nonNegative(row.tokens_cache_read);
          const cacheWrite = nonNegative(row.tokens_cache_write);
          const input = nonNegative(row.tokens_input) + cacheRead;
          const output = nonNegative(row.tokens_output);
          const total = input + cacheWrite + output;
          const time = toEpochMs(row.time_created);
          if (total <= 0 || !Number.isFinite(time)) continue;
          const model = typeof row.model === 'string' ? row.model : '';
          const [provider, modelId] = model.includes('/') ? model.split('/', 2) : ['unknown', model || 'unknown'];
          records.push({
            agent: null,
            provider,
            model: modelId,
            time,
            input,
            cacheRead,
            cacheWrite,
            output,
            total,
            sessionId: String(row.id ?? ''),
            project: '',
            title: '',
          });
        }
        if (records.length) {
          source = `${table}（会话级汇总，无法拆分到逐请求）`;
          break;
        }
      }
    }

    return { records, source };
  });
}

export async function readOpencode(agent, errors) {
  const base = String(agent.path ?? '');
  if (!existsSync(base)) {
    errors.push({ file: base, message: 'opencode 数据目录不存在' });
    return { records: [], aux: 0 };
  }

  const dbPath = join(base, 'opencode.db');
  if (existsSync(dbPath)) {
    try {
      const { records, source } = readDatabase(dbPath, errors);
      for (const record of records) record.agent = agent.name;
      if (!records.length) errors.push({ file: dbPath, message: '未从数据库中解析出用量记录（表结构可能已变化）' });
      else if (source.includes('汇总')) errors.push({ file: dbPath, message: `数据来源：${source}` });
      return { records, aux: 0 };
    } catch (error) {
      errors.push({ file: dbPath, message: `读取失败：${error.message}` });
      return { records: [], aux: 0 };
    }
  }

  // 旧版文件存储：storage/message/<会话ID>/<消息ID>.json
  const storageDir = join(base, 'storage', 'message');
  if (!existsSync(storageDir)) {
    errors.push({ file: base, message: '未找到 opencode.db，也没有 storage/message 目录' });
    return { records: [], aux: 0 };
  }

  const files = walkFiles(storageDir, { depth: 3, match: (name) => name.endsWith('.json') });
  const records = [];
  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const cached = fileCache.get(file, stat);
    if (cached) {
      records.push(...cached);
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    } catch {
      parsed = null;
    }
    const fallbackSessionId = basename(join(file, '..'));
    const record = parsed ? recordFromMessage(parsed, { sessionId: fallbackSessionId }) : null;
    const list = record ? [record] : [];
    fileCache.put(file, stat, list);
    records.push(...list);
  }

  for (const record of records) record.agent = agent.name;
  return { records, aux: 0 };
}
