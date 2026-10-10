// 限额查询：移植自 dsh-quota-dashboard（linh3071/l-dsh-plugins）
// 支持 deepseek / minimax / glm / sub2api 四个平台，输出统一的归一化结果。

const TIMEOUT_MS = 20_000;
const SHANGHAI = 'Asia/Shanghai';

const PLATFORM_BRAND = {
  deepseek: '#4D6BFE',
  minimax: '#F5533D',
  glm: '#3859FF',
  sub2api: '#8B5CF6',
};

const PLATFORM_NAMES = {
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  glm: 'GLM',
  sub2api: 'Sub2API',
};

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'agent-panel/1.0', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload, text };
}

// ---------- 展示格式化 ----------

function toneOf(usedPercent) {
  if (!Number.isFinite(usedPercent)) return 'neutral';
  if (usedPercent >= 100) return 'bad';
  if (usedPercent >= 80) return 'warn';
  return 'ok';
}

function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

function fmtMoney(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${Number(n.toFixed(2))} ${unit ?? 'USD'}`;
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n)}%`;
}

function fmtTokens(value) {
  const n = nonNegative(value);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return fmtInt(n);
}

function fmtShanghai(epochMs, withYear = false) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '-';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  if (withYear) return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function shanghaiDate(offsetDays = 0) {
  const now = Date.now() + offsetDays * 86_400_000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function asEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 秒级时间戳转换为毫秒
  return n > 10_000_000_000 ? n : n * 1000;
}

function httpError(platform, status, text) {
  const excerpt = String(text ?? '').slice(0, 300);
  return {
    ok: false,
    code: 'http',
    message: `${PLATFORM_NAMES[platform] ?? platform} 返回 HTTP ${status}${excerpt ? `：${excerpt}` : ''}`,
  };
}

function businessError(platform, message) {
  return {
    ok: false,
    code: 'business',
    message: `${PLATFORM_NAMES[platform] ?? platform}：${message || '接口返回业务错误'}`,
  };
}

// ---------- DeepSeek ----------

async function queryDeepSeek(provider) {
  const { status, ok, payload, text } = await getJson('https://api.deepseek.com/user/balance', {
    Authorization: `Bearer ${provider.apiKey}`,
  });
  if (!ok) throw httpError('deepseek', status, text);

  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const available = payload?.is_available !== false;
  const currencySymbol = { CNY: 'CNY', USD: 'USD' }[infos[0]?.currency] ?? 'CNY';

  const summary = [];
  for (const info of infos) {
    const unit = info?.currency === 'USD' ? 'USD' : 'CNY';
    summary.push({
      label: `余额（${unit === 'CNY' ? '人民币' : '美元'}）`,
      value: fmtMoney(info?.total_balance, unit),
      tone: available ? 'ok' : 'bad',
    });
  }
  if (summary.length === 0) {
    summary.push({ label: '余额', value: '无数据', tone: 'neutral' });
  }

  const sections = [
    {
      title: '账户余额',
      head: ['币种', '总余额', '赠送余额', '充值余额'],
      rows: infos.map((info) => ({
        cells: [
          info?.currency === 'USD' ? '美元' : '人民币',
          fmtMoney(info?.total_balance, currencySymbol),
          fmtMoney(info?.granted_balance, currencySymbol),
          fmtMoney(info?.topped_up_balance, currencySymbol),
        ],
      })),
    },
  ];

  const conclusion = available ? '账户可用，余额正常。' : '账户当前不可用（可能欠费或被禁用）。';
  return { status: { kind: available ? 'ok' : 'unavailable' }, summary, sections, conclusion };
}

// ---------- MiniMax ----------

function minimaxGroups(payload) {
  // 实测响应：顶层 model_remains 数组
  if (Array.isArray(payload?.model_remains)) return payload.model_remains.filter((g) => g && typeof g === 'object');
  const root = payload?.data ?? payload ?? {};
  if (Array.isArray(root)) return root.filter((g) => g && typeof g === 'object');
  // 嵌套 data.data：对象映射，容器 key 作为模型名
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return Object.entries(root.data).map(([name, value]) => ({ ...(value ?? {}), _name: name }));
  }
  return Object.entries(root)
    .filter(([key, value]) => key !== 'base_resp' && value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => ({ ...value, _name: key }));
}

function minimaxWindow(group, kind) {
  const prefix = kind === 'interval' ? 'current_interval' : 'current_weekly';
  const label = kind === 'interval' ? '5 小时' : '7 天';
  const remaining = Number(group[`${prefix}_remaining_percent`]);
  const usageCount = Number(group[`${prefix}_usage_count`]);
  const totalCount = Number(group[`${prefix}_total_count`]);
  const endRaw = kind === 'interval' ? group.end_time : group.weekly_end_time;

  let usedPercent = null;
  let remainingPercent = null;
  if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) {
    remainingPercent = remaining;
    usedPercent = 100 - remaining;
  } else if (Number.isFinite(totalCount) && totalCount > 0 && Number.isFinite(usageCount)) {
    usedPercent = Math.min(100, (usageCount / totalCount) * 100);
    remainingPercent = 100 - usedPercent;
  }
  if (usedPercent === null) return null;
  return { label, usedPercent, remainingPercent, usageCount, totalCount, resetAt: asEpochMs(endRaw) };
}

async function queryMiniMax(provider) {
  const { status, ok, payload, text } = await getJson('https://www.minimaxi.com/v1/token_plan/remains', {
    Authorization: `Bearer ${provider.apiKey}`,
  });
  if (!ok) throw httpError('minimax', status, text);
  const base = payload?.base_resp;
  if (base && base.status_code !== 0) throw businessError('minimax', base.status_msg);

  const groups = minimaxGroups(payload);
  const rows = [];
  const worst = {};
  for (const group of groups) {
    const name = group.model_name || group._name || '未知模型';
    for (const kind of ['interval', 'weekly']) {
      const win = minimaxWindow(group, kind);
      if (!win) continue;
      rows.push({
        cells: [name, win.label, fmtPct(win.usedPercent), fmtPct(win.remainingPercent), fmtShanghai(win.resetAt)],
        tones: [null, null, toneOf(win.usedPercent), null, null],
      });
      if (!worst[kind] || win.usedPercent > worst[kind].usedPercent) worst[kind] = { ...win, name };
    }
  }

  const summary = [];
  for (const [kind, label] of [['interval', '5 小时窗口'], ['weekly', '7 天窗口']]) {
    if (!worst[kind]) continue;
    summary.push({
      label: `${label}最紧（${worst[kind].name}）`,
      value: `已用 ${fmtPct(worst[kind].usedPercent)}`,
      tone: toneOf(worst[kind].usedPercent),
      resetAt: worst[kind].resetAt ?? undefined,
    });
  }
  if (summary.length === 0) summary.push({ label: '用量', value: '无数据', tone: 'neutral' });

  const sections = rows.length
    ? [{ title: '各模型余量', head: ['模型', '窗口', '已用', '剩余', '重置'], rows }]
    : [];

  let conclusion = '未获取到模型余量数据。';
  const maxUsed = Math.max(worst.interval?.usedPercent ?? -1, worst.weekly?.usedPercent ?? -1);
  if (maxUsed >= 0) {
    if (maxUsed < 0.01) conclusion = '尚未产生消耗。';
    else if (maxUsed >= 100) conclusion = '配额已用尽，等待窗口重置。';
    else if (maxUsed < 80) conclusion = '各窗口余量充足。';
    else conclusion = '接近上限，注意窗口重置时间。';
  }
  return { status: { kind: 'ok' }, summary, sections, conclusion };
}

// ---------- GLM ----------

function glmLimitItems(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.limits)) return data.limits;
  return [];
}

function glmWindowLabel(item) {
  if (item?.type === 'TIME_LIMIT') return '本月';
  if (Number(item?.unit) === 6) return '本周';
  return '5 小时窗口';
}

async function queryGLM(provider) {
  // GLM 网关要求 Authorization 头直接放原始 key（无 Bearer 前缀）
  const auth = { Authorization: provider.apiKey };
  const limitRes = await getJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', auth);
  if (!limitRes.ok) throw httpError('glm', limitRes.status, limitRes.text);
  const payload = limitRes.payload ?? {};
  if (payload.success === false || (payload.code !== undefined && ![0, 200].includes(payload.code))) {
    throw businessError('glm', payload.msg || payload.message);
  }

  const items = glmLimitItems(payload);
  const rows = [];
  const summary = [];
  for (const item of items) {
    const label = glmWindowLabel(item);
    let used = Number(item.currentValue);
    let limit = Number(item.usage); // GLM 的 usage 字段是上限值
    let usedPercent = Number.isFinite(Number(item.percentage)) ? Number(item.percentage) : null;
    let remaining = null;

    if (item.type === 'TIME_LIMIT') {
      used = Number(item.currentValue);
      limit = Number(item.usage);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
        usedPercent = (used / limit) * 100;
        remaining = limit - used;
      }
    } else {
      if (usedPercent === null && Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
        usedPercent = (used / limit) * 100;
      }
      if (Number.isFinite(limit) && Number.isFinite(used)) remaining = limit - used;
    }
    // 查不到的字段保持 NaN，展示为 '-'

    const name =
      item.type === 'TIME_LIMIT' ? item.name || '联网搜索 / MCP' : item.name || '';
    const rowLabel = name ? `${label} · ${name}` : label;
    const resetAt = Number.isFinite(Number(item.nextResetTime)) ? Number(item.nextResetTime) : null;
    rows.push({
      cells: [
        rowLabel,
        Number.isFinite(used) ? fmtInt(used) : '-',
        Number.isFinite(limit) ? fmtInt(limit) : '-',
        fmtPct(usedPercent),
        Number.isFinite(remaining) ? fmtInt(remaining) : '-',
        fmtShanghai(resetAt),
      ],
      tones: [null, null, null, toneOf(usedPercent), null, null],
    });
    if (Number.isFinite(usedPercent)) {
      summary.push({
        label: name ? `${label}（${name}）` : label,
        value: `已用 ${fmtPct(usedPercent)}`,
        tone: toneOf(usedPercent),
        resetAt: resetAt ?? undefined,
      });
    }
  }

  let plan = '';
  try {
    const subRes = await getJson('https://open.bigmodel.cn/api/biz/subscription/list', auth);
    if (subRes.ok && Array.isArray(subRes.payload?.data) && subRes.payload.data[0]?.productName) {
      plan = String(subRes.payload.data[0].productName);
    }
  } catch {
    // 套餐信息获取失败不影响主结果
  }

  const sections = rows.length ? [{ title: '额度限制', head: ['窗口', '已用', '上限', '使用率', '剩余', '重置'], rows }] : [];
  const worst = summary.reduce((acc, s) => {
    const pct = Number(s.value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(pct) && pct > acc ? pct : acc;
  }, -1);
  let conclusion = worst >= 100 ? '配额已用尽，等待重置。' : worst >= 80 ? '接近上限，注意重置时间。' : '余量充足。';
  if (plan) conclusion = `套餐 ${plan}。${conclusion}`;
  if (!rows.length) conclusion = '未获取到额度数据。';
  return { status: { kind: 'ok' }, summary, sections, conclusion };
}

// ---------- Sub2API ----------

function normalizeWindow(raw) {
  const match = /^(\d+)\s*([hdw])$/i.exec(String(raw ?? '').trim());
  if (!match) return String(raw ?? '');
  const [, n, unit] = match;
  const unitLabel = { h: 'h', d: 'd', w: 'd7' }[unit.toLowerCase()];
  if (unit.toLowerCase() === 'w') return `${Number(n) * 7}d`;
  return `${n}${unitLabel}`;
}

function aggregateDaily(payload) {
  const totals = { requests: 0, total_tokens: 0, actual_cost: 0 };
  // 实测响应中日用量数组在顶层 daily_usage（usage 对象内没有）
  const daily = payload?.daily_usage ?? payload?.usage?.daily_usage;
  if (Array.isArray(daily)) {
    for (const day of daily) {
      totals.requests += nonNegative(day?.requests);
      totals.total_tokens += nonNegative(day?.total_tokens);
      totals.actual_cost += nonNegative(day?.actual_cost);
    }
  }
  return totals;
}

async function querySub2API(provider) {
  const base = new URL(provider.baseURL);
  const url = new URL('/v1/usage', base.origin);
  url.searchParams.set('days', '30');
  url.searchParams.set('start_date', shanghaiDate(-29));
  url.searchParams.set('end_date', shanghaiDate(1));
  url.searchParams.set('timezone', SHANGHAI);

  const { status, ok, payload, text } = await getJson(url, { Authorization: `Bearer ${provider.apiKey}` });
  if (!ok) throw httpError('sub2api', status, text);

  const quota = payload?.quota ?? {};
  const unit = payload?.unit ?? quota.unit ?? 'USD';
  const used = Number.isFinite(Number(quota.used)) ? Number(quota.used) : null;
  const limit = Number.isFinite(Number(quota.limit)) ? Number(quota.limit) : null;
  const remaining = Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : limit !== null && used !== null ? limit - used : null;
  const quotaPercent = limit !== null && limit > 0 && remaining !== null ? ((limit - remaining) / limit) * 100 : null;

  const expiresAt = payload?.expires_at ?? payload?.subscription?.expires_at ?? null;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
  const invalid =
    payload?.isValid === false ||
    ['disabled', 'expired', 'invalid', 'error'].includes(String(payload?.status ?? '').toLowerCase());

  const badge =
    (payload?.planName ? String(payload.planName) : '') ||
    (payload?.mode === 'quota_limited' ? 'API Key 限额' : payload?.mode === 'unrestricted' ? '订阅 / 钱包' : '');

  const summary = [];
  const rows = [];
  let bottleneck = null; // { label, remainingValue, resetAt }

  if (limit !== null || used !== null) {
    summary.push({
      label: '总额度',
      value: quotaPercent !== null ? `已用 ${fmtPct(quotaPercent)}（${fmtMoney(used, unit)} / ${fmtMoney(limit, unit)}）` : fmtMoney(used, unit),
      tone: toneOf(quotaPercent),
      resetAt: Number.isFinite(expiresMs) ? expiresMs : undefined,
    });
    rows.push({
      cells: [
        '总额度',
        fmtMoney(used, unit),
        fmtMoney(limit, unit),
        fmtPct(quotaPercent),
        fmtMoney(remaining, unit),
        Number.isFinite(expiresMs) ? fmtShanghai(expiresMs, true) : '-',
      ],
      tones: [null, null, null, toneOf(quotaPercent), null, null],
    });
    if (limit !== null && remaining !== null) bottleneck = { label: '总额度', remainingValue: remaining, resetAt: expiresMs };
  }

  const rateLimits = Array.isArray(payload?.rate_limits) ? payload.rate_limits : [];
  for (const rl of rateLimits) {
    const label = normalizeWindow(rl?.window);
    const rlUsed = Number(rl?.used);
    const rlLimit = Number(rl?.limit);
    const rlRemaining = Number.isFinite(Number(rl?.remaining)) ? Number(rl.remaining) : rlLimit - rlUsed;
    const rlPercent = Number.isFinite(rlLimit) && rlLimit > 0 && Number.isFinite(rlUsed) ? (rlUsed / rlLimit) * 100 : null;
    const resetMs = rl?.reset_at ? Date.parse(rl.reset_at) : null;
    summary.push({
      label: `${label} 窗口`,
      value: `剩余 ${fmtPct(rlPercent !== null ? 100 - rlPercent : NaN)}`,
      tone: toneOf(rlPercent),
      resetAt: Number.isFinite(resetMs) ? resetMs : undefined,
    });
    rows.push({
      cells: [
        label,
        fmtInt(rlUsed),
        fmtInt(rlLimit),
        fmtPct(rlPercent),
        fmtInt(rlRemaining),
        Number.isFinite(resetMs) ? fmtShanghai(resetMs) : '-',
      ],
      tones: [null, null, null, toneOf(rlPercent), null, null],
    });
    if (Number.isFinite(rlRemaining) && (!bottleneck || rlRemaining < bottleneck.remainingValue)) {
      bottleneck = { label: `${label} 窗口`, remainingValue: rlRemaining, resetAt: resetMs };
    }
  }

  const usage = payload?.usage ?? {};
  const dailyTotals = aggregateDaily(payload);
  const sections = [];
  if (rows.length) {
    sections.push({ title: '额度与限流', head: ['窗口', '已用', '上限', '使用率', '剩余', '重置'], rows });
  }
  sections.push({
    title: '近期用量',
    head: ['范围', '请求数', 'Tokens', '费用'],
    rows: [
      {
        cells: ['今天', fmtInt(usage?.today?.requests), fmtTokens(usage?.today?.total_tokens), fmtMoney(usage?.today?.actual_cost, unit)],
      },
      {
        cells: ['近 30 天', fmtInt(dailyTotals.requests), fmtTokens(dailyTotals.total_tokens), fmtMoney(dailyTotals.actual_cost, unit)],
      },
      {
        cells: ['累计', fmtInt(usage?.total?.requests), fmtTokens(usage?.total?.total_tokens), fmtMoney(usage?.total?.actual_cost, unit)],
      },
    ],
  });

  let conclusion = '未获取到额度信息。';
  if (bottleneck) {
    const reset = Number.isFinite(bottleneck.resetAt) ? `，重置于 ${fmtShanghai(bottleneck.resetAt)}` : '';
    conclusion = `当前瓶颈：${bottleneck.label}（剩余 ${fmtInt(bottleneck.remainingValue)}）${reset}。`;
  }
  if (invalid) conclusion = `Key 不可用（${payload?.status ?? 'invalid'}）。${conclusion}`;

  return {
    status: { kind: invalid ? 'unavailable' : 'ok' },
    badge,
    summary: summary.length ? summary : [{ label: '用量', value: '无数据', tone: 'neutral' }],
    sections,
    conclusion,
  };
}

// ---------- 入口 ----------

const PLATFORM_QUERIES = { deepseek: queryDeepSeek, minimax: queryMiniMax, glm: queryGLM, sub2api: querySub2API };

async function queryOne(provider) {
  const key = provider.id ?? provider.platform ?? 'unknown';
  const platform = String(provider.platform ?? '').toLowerCase();
  const fetchedAt = Date.now();
  const base = { key, platform, name: provider.id ?? PLATFORM_NAMES[platform] ?? key, brand: PLATFORM_BRAND[platform] ?? '#8B5CF6' };

  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) {
    return { ...base, ok: false, fetchedAt, code: 'not_configured', message: `缺少 ${key} 的 apiKey 配置（config.json → quota.providers）` };
  }
  if (platform === 'sub2api' && !/^https:\/\//.test(String(provider.baseURL ?? ''))) {
    return { ...base, ok: false, fetchedAt, code: 'not_configured', message: 'sub2api 需要配置 https 协议的 baseURL' };
  }
  const query = PLATFORM_QUERIES[platform];
  if (!query) {
    return { ...base, ok: false, fetchedAt, code: 'unknown_platform', message: `不支持的平台：${platform || '(空)'}` };
  }
  try {
    const result = await query({ ...provider, apiKey });
    return { ...base, ok: true, fetchedAt, ...result };
  } catch (error) {
    const code = error?.cause?.code || error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'network' : error?.code;
    if (code === 'network') {
      return { ...base, ok: false, fetchedAt, code: 'network', message: `网络请求失败：${error?.message ?? error}` };
    }
    if (code === 'http' || code === 'business') {
      return { ...base, ok: false, fetchedAt, code, message: error.message };
    }
    return { ...base, ok: false, fetchedAt, code: 'internal', message: `内部错误：${error?.stack ?? error}` };
  }
}

export async function queryQuota(providers, key) {
  const list = Array.isArray(providers) ? providers : [];
  const targets = key ? list.filter((p) => p.id === key) : list;
  if (key && targets.length === 0) {
    return { results: [{ key, ok: false, code: 'not_configured', message: `config.json 中不存在 id 为 ${key} 的 provider` }] };
  }
  const results = await Promise.all(targets.map((provider) => queryOne(provider)));
  return { results };
}
