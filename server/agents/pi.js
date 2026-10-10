// pi 用量读取器：{path}/sessions/<项目>/agent_<会话>.jsonl
//
// 条目是带 id / parentId 的树形结构（编辑、重试会产生旁支）：
//   - 旁支条目同样是真实发生过的 API 调用，全部计入（与 ccusage 的 pi 适配器一致），
//     只用「活跃分支」来做 fork 前缀比对
//   - parentSession 指向父会话时，子会话开头重复的父会话历史按签名前缀比对后跳过，
//     避免与父会话重复计数
//   - subagent-artifacts/ 下是派生副本（无会话头、无条目 id），跳过
//
// 口径：usage.input 不含缓存读，换算为面板口径 input = input + cacheRead，
//       total = input + cacheWrite + output。

import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname, resolve, normalize } from 'node:path';
import { nonNegative, walkFiles, statSafe, createRecordCache, parseLine, toEpochMs } from './common.js';

const fileCache = createRecordCache();

function signature(entry) {
  const r = entry.record;
  return `${r.time}\u0000${r.model}\u0000${r.input}\u0000${r.output}\u0000${r.cacheRead}\u0000${r.cacheWrite}`;
}

// 物理位置最后一条是当前叶子，沿 parentId 回溯得到活跃分支（用于 fork 比对）
function activeUsageIndices(links, usage) {
  if (!links.length) return null; // 无 id/parentId 的老版本会话：线性历史
  for (const link of links) if (!link.id) return null; // 链接不完整，无法判定
  const parentsById = new Map();
  for (const link of links) {
    if (parentsById.has(link.id)) return null; // id 重复
    parentsById.set(link.id, link.parentId);
  }
  for (const parent of parentsById.values()) {
    if (parent && !parentsById.has(parent)) return null; // 父节点缺失
  }
  const usageById = new Map();
  usage.forEach((entry, index) => {
    if (entry.entryId) usageById.set(entry.entryId, index);
  });
  const active = [];
  const visited = new Set();
  let current = links[links.length - 1].id;
  for (;;) {
    if (visited.has(current)) return null; // 环
    visited.add(current);
    const index = usageById.get(current);
    if (index !== undefined) active.push(index);
    const parent = parentsById.get(current);
    if (parent === undefined) return null;
    if (parent === null) break;
    current = parent;
  }
  return active.reverse();
}

async function parseSessionFile(file) {
  const usage = [];
  const links = [];
  let headerTime = null;
  let parentSession = null;
  let cwd = '';

  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"usage"') && !line.includes('"session"') && !line.includes('"parentId"') && !line.includes('"cwd"')) continue;
      const event = parseLine(line);
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'session') {
        headerTime = toEpochMs(event.timestamp);
        if (typeof event.parentSession === 'string' && event.parentSession) parentSession = event.parentSession;
        if (typeof event.cwd === 'string') cwd = event.cwd;
        continue;
      }
      if (typeof event.id === 'string' || typeof event.parentId === 'string') {
        links.push({ id: typeof event.id === 'string' ? event.id : null, parentId: typeof event.parentId === 'string' ? event.parentId : null });
      }
      if (typeof event.cwd === 'string') cwd = event.cwd;

      const message = event.message;
      if (!message || typeof message !== 'object') continue;
      if (typeof message.role === 'string' && message.role !== 'assistant') continue;
      const u = message.usage;
      if (!u || typeof u !== 'object') continue;
      const time = toEpochMs(event.timestamp);
      if (!Number.isFinite(time)) continue;

      const cacheRead = nonNegative(u.cacheRead);
      const cacheWrite = nonNegative(u.cacheWrite);
      const input = nonNegative(u.input) + cacheRead; // 面板约定：input 含缓存读
      const output = nonNegative(u.output);
      const total = input + cacheWrite + output;
      if (total <= 0) continue;

      usage.push({
        entryId: typeof event.id === 'string' ? event.id : null,
        record: {
          agent: null,
          provider: 'unknown',
          model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
          time,
          input,
          cacheRead,
          cacheWrite,
          output,
          total,
          sessionId: '',
          project: cwd,
          title: '',
        },
      });
    }
  } finally {
    stream.destroy();
  }
  return { usage, links, headerTime, parentSession, cwd };
}

function matchingPrefix(childActive, parentActive, forkTime) {
  let matched = 0;
  for (let i = 0; i < childActive.length && i < parentActive.length; i++) {
    if (parentActive[i].record.time > forkTime) break;
    if (signature(childActive[i]) !== signature(parentActive[i])) break;
    matched += 1;
  }
  return matched;
}

export async function readPi(agent, errors) {
  const base = String(agent.path ?? '');
  const sessionsDir = basename(base) === 'sessions' ? base : join(base, 'sessions');
  if (!existsSync(sessionsDir)) {
    errors.push({ file: sessionsDir, message: 'pi 会话目录不存在（应包含 sessions/ 子目录）' });
    return { records: [], aux: 0 };
  }

  const files = walkFiles(sessionsDir, {
    depth: 4,
    match: (name, full) => name.endsWith('.jsonl') && !full.includes('/subagent-artifacts/'),
  });
  if (!files.length) {
    errors.push({ file: sessionsDir, message: '未找到会话文件（sessions/*/*.jsonl）' });
    return { records: [], aux: 0 };
  }

  // 1) 解析（带 (mtime, size) 缓存）
  const parsed = new Map(); // file -> data
  const pending = [];
  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const cached = fileCache.get(file, stat);
    if (cached) {
      parsed.set(file, cached);
      continue;
    }
    pending.push(
      parseSessionFile(file)
        .then((data) => {
          fileCache.put(file, stat, data);
          parsed.set(file, data);
        })
        .catch((error) => errors.push({ file, message: `解析失败：${error.message}` })),
    );
  }
  await Promise.all(pending);

  const byPath = new Map();
  for (const file of parsed.keys()) byPath.set(normalize(file), file);

  // 2) 活跃分支索引 + fork 前缀跳过
  const activeByFile = new Map();
  const skipByFile = new Map();
  for (const [file, data] of parsed) {
    const indices = activeUsageIndices(data.links, data.usage);
    activeByFile.set(file, indices === null ? data.usage : indices.map((i) => data.usage[i]));
  }
  for (const [file, data] of parsed) {
    if (!data.parentSession || !Number.isFinite(data.headerTime)) continue;
    const candidates = [normalize(resolve(dirname(file), data.parentSession)), normalize(resolve(data.parentSession))];
    let parentFile = candidates.map((p) => byPath.get(p)).find(Boolean);
    if (!parentFile) {
      // 兜底：按会话 id（文件名）匹配
      const stem = basename(data.parentSession, '.jsonl');
      parentFile = [...parsed.keys()].find((f) => basename(f, '.jsonl') === stem || basename(f) === data.parentSession);
    }
    if (!parentFile || parentFile === file) continue;
    const childActive = activeByFile.get(file) ?? [];
    const parentActive = activeByFile.get(parentFile) ?? [];
    const matched = matchingPrefix(childActive, parentActive, data.headerTime);
    if (matched > 0) skipByFile.set(file, matched);
  }

  // 3) 汇总：跳过 fork 前缀、按条目 id 去重、按时间排序
  const records = [];
  const seen = new Set();
  for (const [file, data] of parsed) {
    const projectDir = basename(dirname(file));
    const sessionId = basename(file, '.jsonl');
    const skip = skipByFile.get(file) ?? 0;
    for (const entry of data.usage.slice(skip)) {
      const record = { ...entry.record };
      record.sessionId = sessionId;
      if (!record.project) record.project = data.cwd || projectDir;
      record.agent = agent.name;
      const key = entry.entryId ? `id:${entry.entryId}` : `sig:${sessionId}:${signature(entry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }
  records.sort((a, b) => a.time - b.time);
  return { records, aux: 0 };
}
