// 模型价格表：从 models.dev 拉取，落盘缓存 + TTL 过期后台刷新。
//
// 更新时机设计（stale-while-revalidate）：
//   1. 服务启动：缓存缺失或已过期 → 后台拉取，不阻塞启动
//   2. 每次用量查询：同样的判断；过期则后台刷新 —— 本次查询仍用旧表，下次查询用新表，
//      查询本身永远不会被网络请求阻塞
//   3. 手动：POST /api/price/refresh 强制拉取（前端「刷新价格」按钮），返回最新状态
//   4. 失败退避：拉取失败后 10 分钟内不再自动重试，避免每次查询都打网络
//   5. 单飞：同一时刻只允许一个拉取在途
//
// 计价口径：完全以 models.dev 的单价为准（美元/百万 token，分 input / output / cache_read / cache_write），
// 乘以实际用量后逐条累加。面板记录的 input_tokens 已包含缓存读，所以未缓存输入 = input − cacheRead。
//
// 注意这是「预估值」：不体现各供应商的峰谷价（如 DeepSeek 高峰时段翻倍）、折扣与赠送额度，
// 也不做汇率换算，实际扣费以各平台账单为准 —— 界面上会明确标注这一点。

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_SOURCE = 'https://models.dev/api.json';
const DEFAULT_TTL_HOURS = 12;
const RETRY_BACKOFF_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_DIR = 'data';
const CACHE_FILE = 'prices.json';

// 面板记录的 provider_id → models.dev provider id（按优先级）
const PROVIDER_ALIASES = {
  deepseek: ['deepseek'],
  'bigmodel-api': ['zhipuai', 'zai'],
  bigmodel: ['zhipuai', 'zai'],
  glm: ['zhipuai', 'zai'],
  zhipuai: ['zhipuai', 'zai'],
  zai: ['zhipuai', 'zai'],
  minimax: ['minimax'],
};

const state = {
  dir: null,
  source: DEFAULT_SOURCE,
  ttlMs: DEFAULT_TTL_HOURS * 3_600_000,
  table: null, // { fetchedAt, source, providers: { providerId: { modelId: {in,out,cr,cw} } } }
  inflight: null,
  lastAttemptAt: 0,
  lastError: null,
  resolution: new Map(), // `${provider}\u0000${model}` -> 价格对象 | null
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeId(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cachePath() {
  return join(state.dir, CACHE_DIR, CACHE_FILE);
}

// ---------- 配置与缓存装载 ----------

export async function configurePrices(config = {}, baseDir) {
  state.dir = baseDir;
  if (typeof config.source === 'string' && config.source.trim()) state.source = config.source.trim();
  const ttl = Number(config.ttlHours);
  state.ttlMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_HOURS) * 3_600_000;
  if (!state.table) await loadTable();
}

async function loadTable() {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8'));
    if (parsed?.providers && typeof parsed.providers === 'object') {
      state.table = {
        fetchedAt: Number(parsed.fetchedAt) || 0,
        source: typeof parsed.source === 'string' ? parsed.source : state.source,
        providers: parsed.providers,
      };
      state.resolution.clear();
    }
  } catch {
    // 无缓存或缓存损坏：保持为空，等后台拉取
  }
}

async function saveTable(table) {
  const path = cachePath();
  await mkdir(join(state.dir, CACHE_DIR), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(table), 'utf8');
  await rename(tmp, path); // 原子替换，避免读到半截文件
}

// ---------- 拉取 ----------

function extractProviders(data) {
  const providers = {};
  let count = 0;
  for (const [pid, provider] of Object.entries(data ?? {})) {
    const models = provider?.models;
    if (!models || typeof models !== 'object') continue;
    const out = {};
    for (const [mid, model] of Object.entries(models)) {
      const cost = model?.cost;
      if (!cost) continue;
      const entry = { in: num(cost.input), out: num(cost.output), cr: num(cost.cache_read), cw: num(cost.cache_write) };
      if (entry.in === null && entry.out === null) continue;
      out[String(mid).toLowerCase()] = entry;
      count += 1;
    }
    if (Object.keys(out).length) providers[String(pid).toLowerCase()] = out;
  }
  if (!count) throw new Error('价格表为空（返回内容不含 cost 字段）');
  return { providers, count };
}

export async function refreshPrices({ force = false } = {}) {
  if (!state.dir) return priceStatus();
  if (state.inflight) return state.inflight;
  if (!force && state.lastError && Date.now() - state.lastAttemptAt < RETRY_BACKOFF_MS) return priceStatus();

  state.lastAttemptAt = Date.now();
  state.inflight = (async () => {
    try {
      const response = await fetch(state.source, {
        headers: { Accept: 'application/json', 'User-Agent': 'agent-panel/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { providers } = extractProviders(await response.json());
      state.table = { fetchedAt: Date.now(), source: state.source, providers };
      state.resolution.clear();
      state.lastError = null;
      await saveTable(state.table);
    } catch (error) {
      state.lastError = error?.message ?? String(error);
    } finally {
      state.inflight = null;
    }
    return priceStatus();
  })();
  return state.inflight;
}

// 过期则后台刷新（不 await，不阻塞调用方）
export function ensureFresh() {
  if (!state.dir) return;
  if (!state.table) {
    void refreshPrices();
    return;
  }
  if (Date.now() - state.table.fetchedAt > state.ttlMs) void refreshPrices();
}

export function priceStatus() {
  const table = state.table;
  const modelCount = table ? Object.values(table.providers).reduce((sum, models) => sum + Object.keys(models).length, 0) : 0;
  return {
    available: !!table,
    fetchedAt: table?.fetchedAt ?? null,
    stale: table ? Date.now() - table.fetchedAt > state.ttlMs : true,
    ttlHours: Math.round(state.ttlMs / 3_600_000),
    source: state.source,
    modelCount,
    refreshing: !!state.inflight,
    lastError: state.lastError,
  };
}

// ---------- 模型匹配 ----------

export function matchPrice(modelId, providerId) {
  if (!state.table) return null;
  const key = `${String(providerId ?? '').toLowerCase()}\u0000${String(modelId ?? '').toLowerCase()}`;
  if (state.resolution.has(key)) return state.resolution.get(key);
  const hit = resolvePrice(modelId, providerId);
  state.resolution.set(key, hit);
  return hit;
}

function resolvePrice(modelId, providerId) {
  const providers = state.table.providers;
  let mid = String(modelId ?? '').trim().toLowerCase();
  if (!mid) return null;
  const candidates = [mid];
  if (mid.includes('/')) candidates.push(mid.split('/').pop()); // 形如 deepseek/deepseek-chat
  const aliases = PROVIDER_ALIASES[String(providerId ?? '').trim().toLowerCase()] ?? [];

  for (const id of candidates) {
    // 1. 对应 provider 内精确
    for (const pid of aliases) {
      const hit = providers[pid]?.[id];
      if (hit) return { ...hit, provider: pid, model: id, approx: false };
    }
    // 2. 全局精确
    for (const [pid, models] of Object.entries(providers)) {
      if (models[id]) return { ...models[id], provider: pid, model: id, approx: false };
    }
    // 3. 归一化精确（忽略大小写与 - . _ 等分隔符）
    const norm = normalizeId(id);
    for (const [pid, models] of Object.entries(providers)) {
      for (const [key, value] of Object.entries(models)) {
        if (normalizeId(key) === norm) return { ...value, provider: pid, model: key, approx: false };
      }
    }
    // 4. provider 内最长前缀（如 MiniMax-M2.7-highspeed → MiniMax-M2.7）
    for (const pid of aliases) {
      const best = longestPrefix(providers[pid], id);
      if (best) return { ...best.value, provider: pid, model: best.key, approx: true };
    }
    // 5. 全局最长前缀
    for (const [pid, models] of Object.entries(providers)) {
      const best = longestPrefix(models, id);
      if (best) return { ...best.value, provider: pid, model: best.key, approx: true };
    }
  }
  return null;
}

function longestPrefix(models, needle) {
  if (!models || needle.length < 4) return null;
  let best = null;
  for (const [key, value] of Object.entries(models)) {
    if (key.length < 4 || key.length > needle.length) continue;
    if (needle.startsWith(key) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best;
}

// ---------- 计价 ----------

// 单条记录花费：价格 × 实际用量。est: 预估口径说明见文件头注释
export function costOf(record) {
  const price = matchPrice(record.model, record.provider);
  if (!price) return { usd: 0, matched: false, approx: false };

  const inputPrice = price.in ?? 0;
  const cacheReadPrice = price.cr ?? inputPrice; // 缺 cache_read 时按普通输入价计（保守）
  const cacheWritePrice = price.cw ?? inputPrice;
  const uncachedInput = Math.max(0, record.input - record.cacheRead);

  const usd =
    (uncachedInput * inputPrice + record.cacheRead * cacheReadPrice + record.cacheWrite * cacheWritePrice + record.output * (price.out ?? 0)) / 1e6;

  return { usd, matched: true, approx: !!price.approx };
}
