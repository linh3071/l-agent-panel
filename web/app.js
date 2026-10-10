// agent-panel 前端逻辑：限额卡片 + 用量统计

const $ = (selector) => document.querySelector(selector);
const DAY_MS = 86_400_000;

// ---------- 格式化 ----------

function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

function fmtTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return fmtInt(n);
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n)}%`;
}

// 费用（美元）：小额保留更多小数，避免显示成 $0.00
function fmtCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTime(epochMs) {
  if (!Number.isFinite(epochMs)) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

function relTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 30_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function countdown(resetAt) {
  if (!Number.isFinite(resetAt)) return '';
  const diff = resetAt - Date.now();
  if (diff <= 0) return '';
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `重置 ${days}d${hours}h`;
  if (hours > 0) return `重置 ${hours}h${minutes}m`;
  return `重置 ${minutes}m`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
    return payload;
  });
}

// ---------- Tab 切换 ----------

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (!button) return;
  const tab = button.dataset.tab;
  document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === button));
  $('#panel-quota').classList.toggle('active', tab === 'quota');
  $('#panel-usage').classList.toggle('active', tab === 'usage');
  if (tab === 'usage' && !usageState.data && !usageState.loading) loadUsage();
});

function setStatus(id, text, isError = false, spinning = false) {
  const node = $(id);
  node.classList.remove('hidden', 'error');
  if (isError) node.classList.add('error');
  node.replaceChildren();
  if (spinning) node.append(el('span', { class: 'spin' }));
  node.append(text ?? '');
  if (text === null || text === undefined || text === '') node.classList.add('hidden');
}

// ---------- 限额 Tab ----------

const quotaState = { results: [], expanded: new Set(), loading: false };

async function loadQuota(key = null) {
  if (quotaState.loading) return;
  quotaState.loading = true;
  setStatus('#quota-status', key ? '正在查询…' : '正在查询全部平台…', false, true);
  try {
    const payload = await postJson('/api/quota/query', key ? { key } : {});
    const incoming = payload.results ?? [];
    if (key) {
      // 单卡刷新：仅替换对应卡片，保留其余卡片与抓取时间
      const updated = quotaState.results.map((result) => incoming.find((item) => item.key === result.key) ?? result);
      for (const item of incoming) {
        if (!updated.some((result) => result.key === item.key)) updated.push(item);
      }
      quotaState.results = updated;
    } else {
      quotaState.results = incoming;
    }
    setStatus('#quota-status', null);
    renderQuotaCards();
  } catch (error) {
    setStatus('#quota-status', `查询失败：${error.message}`, true);
  } finally {
    quotaState.loading = false;
  }
}

function renderQuotaCards() {
  const container = $('#quota-cards');
  container.replaceChildren();

  for (const result of quotaState.results) {
    const card = el('article', { class: `qcard${quotaState.expanded.has(result.key) ? ' expanded' : ''}`, tabindex: '0' });
    const brand = result.brand ?? '#8B5CF6';
    const name = result.name ?? result.key;

    card.append(
      el(
        'div',
        { class: 'qcard-head' },
        el('div', { class: 'qcard-icon', style: `background:${brand}` }, name.slice(0, 1).toUpperCase()),
        el(
          'div',
          { class: 'qcard-name' },
          name,
          result.badge ? el('span', { class: 'qcard-badge', text: result.badge }) : null,
          el('span', {
            class: `qcard-dot${result.ok && result.status?.kind !== 'unavailable' ? '' : ' unavailable'}`,
            title: result.ok && result.status?.kind !== 'unavailable' ? '可用' : '不可用',
          }),
        ),
        el(
          'div',
          { class: 'qcard-head-right' },
          el('span', { class: 'qcard-fetched', 'data-fetched': result.fetchedAt, text: relTime(result.fetchedAt) }),
          el('button', {
            class: 'btn icon',
            title: '刷新此卡片',
            text: '⟳',
            onclick: (event) => {
              event.stopPropagation();
              loadQuota(result.key);
            },
          }),
        ),
      ),
    );

    if (!result.ok) {
      const hint =
        result.code === 'not_configured'
          ? '请在项目根目录 config.json 的 quota.providers 中补全该平台的 apiKey（sub2api 还需 baseURL）。'
          : null;
      card.append(
        el(
          'div',
          { class: 'qcard-error' },
          el('div', { text: result.message ?? `查询失败（${result.code ?? 'unknown'}）` }),
          hint ? el('div', { class: 'hint', text: hint }) : null,
        ),
      );
    } else {
      const summary = el('div', { class: 'qcard-summary' });
      for (const item of result.summary ?? []) {
        const resetText = countdown(item.resetAt);
        summary.append(
          el(
            'div',
            { class: 'qsum' },
            el('span', { class: 'label', text: item.label }),
            el('span', { class: `value tone-${item.tone ?? 'neutral'}` }, item.value ?? '-', resetText ? el('span', { class: 'reset', text: resetText }) : null),
          ),
        );
      }
      card.append(summary);

      if (quotaState.expanded.has(result.key)) {
        const detail = el('div', { class: 'qcard-detail' });
        if (result.conclusion) detail.append(el('div', { class: 'qcard-conclusion', text: result.conclusion }));
        for (const section of result.sections ?? []) {
          const table = el('table', { class: 'data-table' });
          table.append(el('thead', {}, el('tr', {}, ...(section.head ?? []).map((cell) => el('th', { text: cell })))));
          const tbody = el('tbody');
          for (const row of section.rows ?? []) {
            const tr = el('tr');
            (row.cells ?? []).forEach((cell, index) => {
              const tone = row.tones?.[index];
              tr.append(el('td', { class: tone ? `tone-${tone}` : '', text: cell }));
            });
            tbody.append(tr);
          }
          table.append(tbody);
          detail.append(
            el('div', { class: 'block', style: 'margin-top:10px' }, el('div', { style: 'font-size:12px;color:var(--text-dim);margin-bottom:6px', text: section.title }), el('div', { class: 'table-wrap' }, table)),
          );
        }
        card.append(detail);
      }
    }

    card.addEventListener('click', () => {
      if (quotaState.expanded.has(result.key)) quotaState.expanded.delete(result.key);
      else quotaState.expanded.add(result.key);
      renderQuotaCards();
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        card.click();
      }
    });
    container.append(card);
  }
}

// 30 秒滴答：更新相对时间与重置倒计时
setInterval(() => {
  document.querySelectorAll('.qcard-fetched').forEach((node) => {
    const ts = Number(node.dataset.fetched);
    if (Number.isFinite(ts)) node.textContent = relTime(ts);
  });
}, 30_000);

$('#quota-refresh').addEventListener('click', () => loadQuota());

// ---------- 用量 Tab ----------

const usageState = { groupBy: 'agent', range: 'today', customFrom: null, customTo: null, data: null, loading: false };

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function computeRange() {
  const today = startOfToday();
  switch (usageState.range) {
    case '7d':
      return { from: today - 6 * DAY_MS, to: today + DAY_MS };
    case '30d':
      return { from: today - 29 * DAY_MS, to: today + DAY_MS };
    case 'custom': {
      const fromStr = $('#usage-from').value;
      const toStr = $('#usage-to').value;
      let from = fromStr ? Date.parse(`${fromStr}T00:00:00`) : NaN;
      let to = toStr ? Date.parse(`${toStr}T00:00:00`) + DAY_MS : NaN;
      if (Number.isFinite(from) && Number.isFinite(to) && from > to) [from, to] = [to - DAY_MS, from + DAY_MS];
      return { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null };
    }
    default:
      return { from: today, to: today + DAY_MS };
  }
}

async function loadUsage() {
  if (usageState.loading) return;
  usageState.loading = true;
  setStatus('#usage-status', '正在统计用量（首次扫描 Codex 会话可能需要数秒）…', false, true);
  try {
    const { from, to } = computeRange();
    const payload = await postJson('/api/usage/query', { from, to, groupBy: usageState.groupBy });
    usageState.data = payload;
    setStatus('#usage-status', null);
    renderUsage();
  } catch (error) {
    setStatus('#usage-status', `统计失败：${error.message}`, true);
  } finally {
    usageState.loading = false;
  }
}

function renderUsage() {
  const data = usageState.data;
  if (!data) return;
  const totals = data.totals ?? {};

  // 汇总卡片（固定 8 个）：请求数 / 会话数 / 总 Token / 预估费用 / 输入 / 输出 / 缓存 / 缓存命中率
  // 口径：zcode/codex 的 input_tokens 均已包含缓存读，所以「输入」为未缓存部分、命中率 = cacheRead / input
  const cacheDenom = totals.input;
  const cacheHit = cacheDenom > 0 ? (totals.cacheRead / cacheDenom) * 100 : null;
  const uncachedInput = Math.max(0, totals.input - totals.cacheRead);
  const price = data.meta?.price;
  const cards = [
    { label: '请求数', value: fmtInt(totals.requests) },
    { label: '会话数', value: fmtInt(totals.sessions) },
    { label: '总 Token', value: fmtTokens(totals.total) },
    {
      label: '预估费用',
      value: price?.available ? fmtCost(totals.cost) : '—',
      sub: price ? (price.available ? 'models.dev 单价 × 用量（估算）' : '价格表不可用') : '未启用价格估算',
    },
    { label: '输入', value: fmtTokens(uncachedInput), sub: '未缓存（输入总量 − 缓存读）' },
    { label: '输出', value: fmtTokens(totals.output) },
    { label: '缓存', value: fmtTokens(totals.cacheRead), sub: `缓存写 ${fmtTokens(totals.cacheWrite)}` },
    { label: '缓存命中率', value: fmtPct(cacheHit), sub: 'cacheRead / 输入总量' },
  ];
  const summary = $('#usage-summary');
  summary.replaceChildren();
  for (const card of cards) {
    summary.append(
      el('div', { class: 'scard' }, el('div', { class: 'label', text: card.label }), el('div', { class: 'value', text: card.value }), card.sub ? el('div', { class: 'sub', text: card.sub }) : null),
    );
  }

  // 分组表
  const groupLabel = data.groupBy === 'model' ? '模型' : 'Agent';
  $('#usage-groups-title').textContent = `分组统计（按${groupLabel}）`;
  $('#usage-groups-head').replaceChildren(
    el('th', { text: groupLabel }),
    el('th', { class: 'num', text: '请求数' }),
    el('th', { class: 'num', text: '输入' }),
    el('th', { class: 'num', text: '缓存读' }),
    el('th', { class: 'num', text: '缓存写' }),
    el('th', { class: 'num', text: '输出' }),
    el('th', { class: 'num', text: '总 Tokens' }),
    el('th', { class: 'num', text: '费用' }),
    el('th', { text: '占比' }),
  );
  const groupsBody = $('#usage-groups-body');
  groupsBody.replaceChildren();
  for (const group of data.groups ?? []) {
    const tr = el('tr');
    tr.append(el('td', { text: group.key }));
    for (const value of [group.requests, group.input, group.cacheRead, group.cacheWrite, group.output, group.total]) {
      tr.append(el('td', { class: 'num', text: value >= 10000 ? fmtTokens(value) : fmtInt(value) }));
    }
    tr.append(el('td', { class: 'num', text: fmtCost(group.cost) }));
    const sharePct = Math.round((group.share ?? 0) * 100);
    // 灰色轨道按 100% 刻度，填充宽度即真实占比
    tr.append(
      el(
        'td',
        {},
        el(
          'span',
          { class: 'share-box' },
          el('span', { class: 'share-track' }, el('span', { class: 'share-fill', style: `width:${sharePct}%` })),
          el('span', { class: 'share-text', text: `${sharePct}%` }),
        ),
      ),
    );
    groupsBody.append(tr);
  }
  $('#usage-groups-wrap').classList.toggle('hidden', !(data.groups ?? []).length);

  // 热力图
  renderHeatmap(data.days ?? []);

  // 会话表（Top 10）
  const sessionsBody = $('#usage-sessions-body');
  sessionsBody.replaceChildren();
  (data.sessions ?? []).forEach((session, index) => {
    sessionsBody.append(
      el(
        'tr',
        {},
        el('td', { class: 'num', text: String(index + 1) }),
        el('td', { text: session.agent }),
        el('td', { class: 'ellipsis', title: session.title || session.id, text: session.title || '-' }),
        el('td', { class: 'ellipsis', title: session.project, text: session.project || '-' }),
        el('td', { text: session.model || '-' }),
        el('td', { class: 'num', text: fmtInt(session.requests) }),
        el('td', { class: 'num', text: fmtTokens(session.total) }),
        el('td', { class: 'num', text: fmtCost(session.cost) }),
      ),
    );
  });
  $('#usage-sessions-wrap').classList.toggle('hidden', !(data.sessions ?? []).length);

  // 底部 meta
  const meta = data.meta ?? {};
  const coverage = meta.coverage ?? {};
  const lines = [
    `统计时间：${fmtTime(data.generatedAt)} · 扫描耗时 ${meta.scanMs ?? 0}ms · 记录数 ${fmtInt(meta.recordCount ?? 0)}`,
    coverage.from && coverage.to ? `数据覆盖：${fmtTime(coverage.from)} ～ ${fmtTime(coverage.to)}` : null,
    meta.aux?.titleRequests ? `辅助请求（标题生成）：${fmtInt(meta.aux.titleRequests)} 次，未计入主统计` : null,
    data.groupBy === 'model' ? null : '注：按 Agent 分组基于 config.json 中 usage.agents 的 name 字段。',
  ].filter(Boolean);
  for (const error of meta.errors ?? []) {
    lines.push(`⚠ ${error.file}：${error.message}`);
  }
  const metaNode = $('#usage-meta');
  metaNode.replaceChildren(...lines.map((line) => el('div', { text: line })));
  if (price) metaNode.append(renderPriceLine(price));
  metaNode.classList.remove('hidden');
}

// 价格表状态行：更新时间 / TTL / 未匹配模型提示 / 手动刷新按钮
function renderPriceLine(price) {
  const wrap = el('div', { class: 'meta-price' });
  if (!price.available) {
    wrap.append(el('span', { text: price.lastError ? `价格表不可用：${price.lastError}` : '价格表暂不可用（正在拉取…）' }));
  } else {
    const parts = [
      `价格表：更新于 ${fmtTime(price.fetchedAt)}`,
      `TTL ${price.ttlHours}h${price.stale ? '（已过期，后台刷新中）' : ''}`,
      `${fmtInt(price.modelCount)} 个模型`,
      '来源 models.dev',
    ];
    wrap.append(el('span', { text: parts.join(' · ') }));
  }
  if (price.lastError && price.available) {
    wrap.append(el('span', { class: 'meta-warn', text: `⚠ 上次刷新失败：${price.lastError}` }));
  }
  if (price.unmatched?.length) {
    wrap.append(
      el('span', {
        class: 'meta-warn',
        text: `⚠ 未匹配价格（按 $0 计）：${price.unmatched.map((item) => `${item.model}（${fmtInt(item.requests)} 次）`).join('、')}`,
      }),
    );
  }
  if (price.approx?.length) {
    wrap.append(el('span', { class: 'meta-warn', text: `注：${price.approx.join('、')} 为前缀近似匹配（价格可能略有差异）` }));
  }
  const button = el('button', { class: 'btn tiny', text: price.refreshing ? '刷新中…' : '刷新价格' });
  if (price.refreshing) button.disabled = true;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '刷新中…';
    try {
      await postJson('/api/price/refresh', {});
    } catch {
      // 失败时重新查询，meta 中会显示 lastError
    }
    loadUsage();
  });
  wrap.append(button);
  // 口径说明：这是预估值，避免与实际账单混淆
  wrap.append(
    el('div', {
      class: 'meta-note',
      text: '费用为预估值：按 models.dev 的当前单价 × 实际用量逐条计算，不含各平台的峰谷价（如 DeepSeek 高峰时段翻倍）、折扣与赠送额度，也未做汇率换算；实际扣费以各平台账单为准。',
    }),
  );
  return wrap;
}

function renderHeatmap(days) {
  const area = $('#heatmap-area');
  if (!days.length) {
    area.classList.add('hidden');
    return;
  }
  area.classList.remove('hidden');

  const max = days.reduce((acc, day) => Math.max(acc, day.total), 0);

  // 按周分列（周一为第一行）
  const columns = [];
  let column = null;
  for (const day of days) {
    const weekday = (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (weekday === 0 || !column) {
      column = [];
      columns.push(column);
    }
    column.push({ ...day, weekday });
  }

  // 横轴：月份标签（月份变化的第一列标注）
  const months = $('#heat-months');
  months.replaceChildren();
  let prevMonth = -1;
  for (const col of columns) {
    const month = Number(col[0].date.slice(5, 7));
    const label = el('span', {});
    if (month !== prevMonth) {
      label.textContent = `${month}月`;
      prevMonth = month;
    }
    months.append(label);
  }

  // 纵轴：周一 ~ 周日
  const yaxis = $('#heat-yaxis');
  yaxis.replaceChildren();
  for (const label of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
    yaxis.append(el('span', { text: label }));
  }

  const container = $('#heatmap');
  container.replaceChildren();
  for (const col of columns) {
    const node = el('div', { class: 'heat-col' });
    for (let row = 0; row < 7; row += 1) {
      const day = col[row];
      if (!day) {
        node.append(el('div', { class: 'heat-cell empty' }));
        continue;
      }
      const level =
        day.total <= 0 || max <= 0 ? 0 : day.total <= max * 0.25 ? 1 : day.total <= max * 0.5 ? 2 : day.total <= max * 0.75 ? 3 : 4;
      const isFuture = Date.parse(`${day.date}T00:00:00+08:00`) > Date.now();
      node.append(
        el('div', {
          class: `heat-cell${day.total > 0 ? ` heatLevel${level}` : ''}${isFuture ? ' empty' : ''}`,
          title: `${day.date} · ${day.total > 0 ? `${fmtTokens(day.total)} tokens` : '无用量'}`,
        }),
      );
    }
    container.append(node);
  }
}

$('#usage-group').addEventListener('click', (event) => {
  const button = event.target.closest('.seg-item');
  if (!button || button.dataset.group === usageState.groupBy) return;
  usageState.groupBy = button.dataset.group;
  document.querySelectorAll('#usage-group .seg-item').forEach((node) => node.classList.toggle('active', node === button));
  loadUsage();
});

$('#usage-range').addEventListener('click', (event) => {
  const button = event.target.closest('.seg-item');
  if (!button) return;
  usageState.range = button.dataset.range;
  document.querySelectorAll('#usage-range .seg-item').forEach((node) => node.classList.toggle('active', node === button));
  $('#usage-custom').classList.toggle('hidden', usageState.range !== 'custom');
  if (usageState.range !== 'custom') loadUsage();
});

$('#usage-apply').addEventListener('click', () => loadUsage());
$('#usage-refresh').addEventListener('click', () => loadUsage());

// ---------- 初始化 ----------

loadQuota();

// 心跳：便携版据此判断窗口是否仍在打开（关闭窗口后不再上报，服务端自动退出）
const ping = () => fetch('/api/ping', { method: 'POST' }).catch(() => {});
ping();
setInterval(ping, 5000);
