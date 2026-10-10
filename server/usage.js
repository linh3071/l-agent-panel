// 用量统计：按 agent 类型派发到各自的读取器（server/agents/），再做聚合与计价。
//
// 读取器契约：async (agent, errors) => { records, aux? }
//   records: { agent, provider, model, time, input, cacheRead, cacheWrite, output, total, sessionId, project, title }
//   统一约定：input 含缓存读（未缓存输入 = input − cacheRead），total = input + cacheWrite + output
//   aux：辅助请求数（如标题生成），不计入主统计、只在底部展示
//
// 支持的类型见 server/agents/index.js 的注册表（新增 agent 只需加一个读取器模块 + 注册）。

import { configurePrices, ensureFresh, costOf, priceStatus } from './prices.js';
import { getReader, SUPPORTED_TYPES } from './agents/index.js';

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000; // UTC+8 日切分
const MAX_SESSION_ROWS = 10;
const MAX_ERRORS = 10;

function emptyTotals() {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: 0, sessions: 0 };
}

function addTo(totals, record, cost = null) {
  totals.requests += 1;
  totals.input += record.input;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.output += record.output;
  totals.total += record.total;
  if (cost?.matched) totals.cost += cost.usd;
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

export async function queryUsage(agents, { from, to, groupBy, price, dir }) {
  const startedAt = Date.now();
  const errors = [];
  let auxTitle = 0;
  const records = [];

  // 价格表：装载缓存并（必要时）后台刷新 —— 不阻塞本次查询，本次用已有表格计价
  let pricing = false;
  if (price?.enabled !== false) {
    try {
      await configurePrices(price ?? {}, dir);
      ensureFresh();
      pricing = true;
    } catch (error) {
      errors.push({ file: 'prices', message: `价格表初始化失败：${error.message}` });
    }
  }
  const unmatched = new Map(); // 未匹配价格的模型 → 请求数
  let approxModels = new Set(); // 前缀近似匹配到的模型

  for (const agent of agents) {
    const type = String(agent.type ?? '').trim().toLowerCase();
    const reader = getReader(type);
    if (!reader) {
      errors.push({ file: agent.path ?? '', message: `未知的 agent type：${type || '(空)'}（支持 ${SUPPORTED_TYPES.join(' / ')}）` });
      continue;
    }
    try {
      const { records: agentRecords, aux = 0 } = await reader(agent, errors);
      auxTitle += aux;
      records.push(...agentRecords);
    } catch (error) {
      errors.push({ file: agent.path ?? '', message: `读取失败：${error.message}` });
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
    const cost = pricing ? costOf(record) : null;
    if (cost && !cost.matched) unmatched.set(record.model, (unmatched.get(record.model) ?? 0) + 1);
    if (cost?.approx) approxModels.add(record.model);

    addTo(totals, record, cost);
    if (coverageFrom === null || record.time < coverageFrom) coverageFrom = record.time;
    if (coverageTo === null || record.time > coverageTo) coverageTo = record.time;

    const groupKey = groupBy === 'model' ? record.model : record.agent;
    let group = groups.get(groupKey);
    if (!group) {
      group = { key: groupKey, agent: record.agent, model: record.model, ...emptyTotals() };
      groups.set(groupKey, group);
    }
    addTo(group, record, cost);

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
          cost: 0,
          models: new Map(),
        };
        sessions.set(sessionKey, session);
      }
      session.requests += 1;
      session.total += record.total;
      if (cost?.matched) session.cost += cost.usd;
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
        cost: session.cost,
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
      price: pricing
        ? {
            ...priceStatus(),
            unmatched: [...unmatched.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([model, requests]) => ({ model, requests })),
            approx: [...approxModels].slice(0, 8),
          }
        : null,
    },
  };
}
