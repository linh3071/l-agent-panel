// dsh（DeepSeek Harness）用量读取器：{path}/sessions/<项目>/<会话>/session.v4.jsonl.zstd
//
// 会话日志是 Zstandard 压缩的 JSONL，可能由多个帧拼接（写入过程中最后一段可能是半截帧）。
// 事件类型：
//   { type: 'session', id, cwd }                                   会话元信息
//   { type: 'assistant/message', time, data: {
//       message: { source: { provider, model }, content },
//       usage: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens } } }
//       其中 inputTokens 为「未缓存」的输入部分，outputTokens 含推理
//   { type: 'session/title-llm-request' | 'web/deepseek-search-llm-request', time }
//       辅助请求（标题生成 / 搜索改写），只计数、无用量
//
// 与 dsh-usage-stats 参考实现保持一致：未上报 usage 的结算用固定 4 字符/token 的启发式
// 估算输出（输入保持 0）。口径换算：input = inputTokens + cacheReadTokens，
// total = input + cacheWriteTokens + output。

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { nonNegative, walkFiles, statSafe, createRecordCache, parseLine } from './common.js';

const ZSTD_MAGIC = 0xfd2fb528;
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
const LOG_FILENAME = 'session.v4.jsonl.zstd';

const fileCache = createRecordCache();

const zstdAvailable = typeof zstdDecompressSync === 'function';

// 定位结构完整的 Zstandard 帧（跳过写入中的半截最后一帧），移植自 dsh-usage-stats
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`Zstandard 帧头无效（offset ${offset}）`);
    offset += 4;
    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error('Zstandard 帧头保留位非零');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error('Zstandard 块类型保留值');
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push([start, offset]);
  }
  return frames;
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseLine(trimmed);
    if (event) events.push(event);
  }
  return events;
}

function decodeLogFile(file) {
  const buffer = readFileSync(file);
  let frames;
  try {
    frames = scanZstdFrames(buffer);
  } catch {
    // 帧头异常：退化为整段解压（正常写入的日志不会走到这里）
    return parseEvents(zstdDecompressSync(buffer).toString('utf8'));
  }
  // 必须逐帧解压：日志是多帧拼接的，对整段调用解压只会得到第一帧的内容
  const events = [];
  for (const [start, end] of frames) {
    try {
      events.push(...parseEvents(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')));
    } catch {
      // 单帧损坏则跳过该帧
    }
  }
  return events;
}

// 未上报 usage 时的输出估算（与 @deepseek-ai/dsh-token-meter 的 assistant 口径一致）
function estimateAssistantOutput(content) {
  let tokens = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
    } else if (block.type === 'tool-call') {
      tokens +=
        Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN) +
        Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN) +
        BLOCK_OVERHEAD;
    } else {
      tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return tokens + ROLE_OVERHEAD;
}

function foldEvents(events, sessionFallback, cwdFallback) {
  const records = [];
  let aux = 0;
  let sessionId = sessionFallback;
  let cwd = cwdFallback;
  let title = '';

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'session') {
      if (typeof event.id === 'string' && event.id) sessionId = event.id;
      if (typeof event.cwd === 'string' && event.cwd) cwd = event.cwd;
      continue;
    }
    if (event.type === 'session/title-llm-request' || event.type === 'web/deepseek-search-llm-request') {
      aux += 1; // 辅助请求：无用量，只计数
      continue;
    }
    if (event.type !== 'assistant/message') continue;

    const time = Number(event.time);
    if (!Number.isFinite(time)) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const message = data.message && typeof data.message === 'object' ? data.message : {};
    const source = message.source && typeof message.source === 'object' ? message.source : {};
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : null;

    const cacheRead = usage ? nonNegative(usage.cacheReadTokens) : 0;
    const cacheWrite = usage ? nonNegative(usage.cacheWriteTokens) : 0;
    const input = (usage ? nonNegative(usage.inputTokens) : 0) + cacheRead; // 面板约定：input 含缓存读
    // 上报了 outputTokens（哪怕是 0）就用它，否则按内容启发式估算
    const reportedOutput = usage ? Number(usage.outputTokens) : Number.NaN;
    const output = Number.isFinite(reportedOutput) && reportedOutput >= 0 ? reportedOutput : estimateAssistantOutput(message.content);
    const total = input + cacheWrite + output;
    if (total <= 0) continue;

    records.push({
      agent: null,
      provider: typeof source.provider === 'string' && source.provider ? source.provider : 'unknown',
      model: typeof source.model === 'string' && source.model ? source.model : 'unknown',
      time,
      input,
      cacheRead,
      cacheWrite,
      output,
      total,
      sessionId,
      project: cwd,
      title,
    });
  }
  return { records, aux };
}

export async function readDsh(agent, errors) {
  const base = String(agent.path ?? '');
  const sessionsDir = basename(base) === 'sessions' ? base : join(base, 'sessions');
  if (!existsSync(sessionsDir)) {
    errors.push({ file: sessionsDir, message: 'dsh 会话目录不存在（应包含 sessions/ 子目录）' });
    return { records: [], aux: 0 };
  }
  if (!zstdAvailable) {
    errors.push({ file: sessionsDir, message: '当前 Node 不支持 zstd（需 ≥ 22.15 / 23.8），请升级 Node' });
    return { records: [], aux: 0 };
  }

  const files = walkFiles(sessionsDir, { depth: 3, match: (name) => name === LOG_FILENAME });
  if (!files.length) {
    errors.push({ file: sessionsDir, message: `未找到会话日志（sessions/*/*/${LOG_FILENAME}）` });
    return { records: [], aux: 0 };
  }

  const records = [];
  let aux = 0;
  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const cached = fileCache.get(file, stat);
    if (cached) {
      records.push(...cached.records);
      aux += cached.aux;
      continue;
    }
    const sessionFallback = basename(join(file, '..'));
    const projectFallback = basename(join(file, '..', '..'));
    try {
      const { records: fileRecords, aux: fileAux } = foldEvents(decodeLogFile(file), sessionFallback, projectFallback);
      fileCache.put(file, stat, { records: fileRecords, aux: fileAux });
      records.push(...fileRecords);
      aux += fileAux;
    } catch (error) {
      errors.push({ file, message: `解析失败：${error.message}` });
    }
  }

  for (const record of records) record.agent = agent.name;
  return { records, aux };
}
