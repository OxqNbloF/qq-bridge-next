#!/usr/bin/env node
import { resolveApiPath } from '../src/policy/api-paths.js';
/** 离线预览控制台：不加载真实模块、凭据，也不连网 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCharStats, roleSectionReport } from '../src/role-card.js';
import { pickBucketMs } from '../src/token-ledger.js';
import { manualDirCommand } from '../src/state-acl.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';

// 预设状态：mock 直接复用真实字段口径，避免与 bridge.js 漂移。
function presetStatusFixture(preset) {
  return {
    preset,
    label: preset === 'qq-chat' ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: `dsh/agent-presets/${preset}/agent.cordis.yml`,
    installed: true,
    requiresRestart: true,
  };
}

// ── 令牌与花费：编造的示例数据 ──
// 字段和真实账本保持一致，预览看到的样子才和线上一样。
const USAGE_SYMBOL = '¥';
const USAGE_PRICE_TABLE = {
  version: '2026-11-04',
  currency: 'CNY',
  symbol: USAGE_SYMBOL,
  unit: 1e6,
  peakMultiplier: 2,
  peakWindows: [[9, 12], [14, 18]],
  peakWeekdays: [1, 2, 3, 4, 5],
  holidayCount: 33,
  models: {
    'deepseek-flash': { label: 'DeepSeek-V4.1-Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
    'deepseek-v4-pro': { label: 'DeepSeek-V4-Pro-0813', off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 } },
  },
};

// 造一条会话的花费示例
function usageConversationFixture(key, buckets, cost, turns, steps, unattributed = 0) {
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  return {
    key,
    sessionIds: [`fixture-session-${key.replace(/\W/g, '')}`],
    sessions: 1,
    buckets,
    cost,
    unattributedCost: unattributed,
    attributedCost: cost - unattributed,
    byTier: { peak: cost * 0.4, off: cost * 0.6 },
    turns,
    steps,
    estimated: false,
    lastAt: Date.parse(timestamp),
    firstAt: Date.parse(timestamp) - 3600_000,
    models: ['deepseek-flash'],
    cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
  };
}

// 造汇总的花费示例
function usageSummaryFixture() {
  const conversations = [
    usageConversationFixture('group:123456789', { cacheMiss: 41230, cacheHit: 1284000, cacheWrite: 0, output: 18420, reasoning: 0 }, 0.2886, 42, 231),
    usageConversationFixture('private:100001', { cacheMiss: 8600, cacheHit: 210400, cacheWrite: 0, output: 3900, reasoning: 0 }, 0.0467, 9, 48),
    usageConversationFixture('internal:黑话学习', { cacheMiss: 2200, cacheHit: 18000, cacheWrite: 0, output: 900, reasoning: 0 }, 0.0075, 3, 11),
  ];
  const buckets = conversations.reduce((acc, c) => ({
    cacheMiss: acc.cacheMiss + c.buckets.cacheMiss,
    cacheHit: acc.cacheHit + c.buckets.cacheHit,
    cacheWrite: acc.cacheWrite + c.buckets.cacheWrite,
    output: acc.output + c.buckets.output,
    reasoning: 0,
  }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const cost = conversations.reduce((acc, c) => acc + c.cost, 0);
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const turns = conversations.reduce((acc, c) => acc + c.turns, 0);
  const steps = conversations.reduce((acc, c) => acc + c.steps, 0);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    priceVersion: USAGE_PRICE_TABLE.version,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    nowTier: { model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'off', tierLabel: '空闲时段', estimated: false },
    priceTable: USAGE_PRICE_TABLE,
    totals: {
      buckets,
      cost,
      attributedCost: cost - 0.02,
      unattributedCost: 0.02,
      byTier: { peak: cost * 0.4, off: cost * 0.6 },
      turns,
      steps,
      conversations: conversations.length,
      estimated: false,
      totalTokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output,
      inputTokens: input,
      cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
      avgCostPerTurn: cost / turns,
      avgCostPerStep: cost / steps,
    },
    conversations,
    ledger: { file: '(fixture)', journalLines: 0, maxLines: 20000, droppedLines: 0, sessions: 3, baselines: 3, samples: steps, lastIngestAt: Date.parse(timestamp), lastCompactedAt: 0, priceVersion: USAGE_PRICE_TABLE.version },
  };
}

// 走势图示例：24 小时切成 48 格，故意留出空白时段。
// 高峰时段按真实规则算，图才和实际使用一样有两条高峰带。
// 时间定在周三：落在周日的话整条图都是空闲色，看不出高峰。
function usageSeriesFixture(hoursRaw) {
  const hours = [24, 72, 168, 720].includes(Number(hoursRaw)) ? Number(hoursRaw) : 24;
  // 桶的宽度也用真实的那套算法，免得预览和线上不一样
  const bucketMs = pickBucketMs(hours * 3600 * 1000, 48);
  const anchor = Date.parse('2026-09-16T08:30:00.000Z'); // 周三
  const end = Math.floor(anchor / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil((hours * 3600 * 1000) / bucketMs) * bucketMs;
  const count = Math.round((end - start) / bucketMs);
  // 判断这个时间是不是高峰时段
  const isPeakHour = (ms) => {
    const d = new Date(ms);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  };
// 判断桶的档位要看整段时间，不能只看头尾，否则会误判
  const tierOfBucket = (t) => {
    let sawPeak = false;
    let sawOff = false;
    for (let ms = t; ms < t + bucketMs; ms += Math.min(bucketMs, 30 * 60 * 1000)) {
      if (isPeakHour(ms)) sawPeak = true; else sawOff = true;
      if (sawPeak && sawOff) return 'mixed';
    }
    return sawPeak ? 'peak' : 'off';
  };
  const buckets = [];
// 桶里按 30 分钟小格累加，不能只看起点。
// 粗桶的起点可能落在深夜，只看起点整条图会全是 0。
  const subStepMs = Math.min(bucketMs, 30 * 60 * 1000);
  for (let i = 0; i < count; i += 1) {
    const t = start + i * bucketMs;
    let cacheMiss = 0;
    let cacheHit = 0;
    let output = 0;
    let cost = 0;
    let turns = 0;
    let steps = 0;
    for (let ms = t; ms < t + bucketMs; ms += subStepMs) {
      const hour = new Date(ms).getHours();
      if (hour < 9 || hour > 23) continue; // 深夜为 0，图上有明显的空白段
      const wave = (Math.sin((ms - start) / (3 * subStepMs)) + 1) / 2;
      const cm = Math.round(300 + wave * 1800);
      const ch = Math.round(6000 + wave * 42000);
      const out = Math.round(60 + wave * 400);
      const sub = (cm / 1e6) * 1 + (ch / 1e6) * 0.02 + (out / 1e6) * 4;
      cacheMiss += cm;
      cacheHit += ch;
      output += out;
      cost += isPeakHour(ms) ? sub * 2 : sub; // 高峰单价 ×2，逐格判定
      turns += 1;
      steps += 3 + (Math.floor(ms / subStepMs) % 5);
    }
    buckets.push({
      t,
      cost,
      tokens: cacheMiss + cacheHit + output,
      cacheMiss,
      cacheHit,
      cacheWrite: 0,
      output,
      turns,
      steps,
      tier: tierOfBucket(t),
      keys: steps > 0 ? ['group:123456789'] : [],
    });
  }
  const totals = buckets.reduce((acc, b) => ({
    cost: acc.cost + b.cost,
    tokens: acc.tokens + b.tokens,
    turns: acc.turns + b.turns,
    steps: acc.steps + b.steps,
  }), { cost: 0, tokens: 0, turns: 0, steps: 0 });
  const busiest = buckets.reduce((best, b) => (!best || b.cost > best.cost ? b : best), null);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    hours,
    bucketMs,
    from: start,
    to: end,
    buckets,
    totals,
    busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
    estimated: false,
    countedSamples: buckets.reduce((n, b) => n + b.steps, 0),
    offChartCost: 0.02,
    offChartTokens: 18000,
  };
}

// 造逐轮明细的示例
function usageTurnsFixture(key) {
  const target = key || 'group:123456789';
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const buckets = { cacheMiss: 900 + i * 120, cacheHit: 32000 + i * 800, cacheWrite: 0, output: 420 + i * 30, reasoning: 0 };
    rows.push({
      sessionId: `fixture-session-${target.replace(/\W/g, '')}`,
      key: target,
      turn: 42 - i,
      steps: 4 + (i % 3),
      attempts: i === 2 ? 1 : 0,
      startedAt: base - (i + 1) * 600_000,
      endedAt: base - i * 600_000,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      buckets,
      cost: (buckets.cacheMiss / 1e6) * 1 + (buckets.cacheHit / 1e6) * 0.02 + (buckets.output / 1e6) * 4,
      tier: i === 1 ? 'peak' : (i === 4 ? 'mixed' : 'off'),
    });
  }
  const cost = rows.reduce((acc, t) => acc + t.cost, 0);
  return {
    ok: true,
    generatedAt: base,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    key: target,
    sessionIds: [`fixture-session-${target.replace(/\W/g, '')}`],
    sessions: 1,
    steps: rows.reduce((acc, t) => acc + t.steps, 0),
    cost,
    attributedCost: cost,
    unattributedCost: 0.0123,
    buckets: rows.reduce((acc, t) => ({
      cacheMiss: acc.cacheMiss + t.buckets.cacheMiss,
      cacheHit: acc.cacheHit + t.buckets.cacheHit,
      cacheWrite: 0,
      output: acc.output + t.buckets.output,
      reasoning: 0,
    }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }),
    byTier: { peak: cost * 0.3, off: cost * 0.7 },
    estimated: false,
    models: ['deepseek-flash'],
    turnLimit: 200,
    // 和真实账本一样，turns 是每一轮的明细，不是条数
    turns: rows,
  };
}

// 造最近花费记录的示例
function usageRecentFixture() {
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      time: base - i * 45_000,
      key: i % 3 === 2 ? 'private:100001' : 'group:123456789',
      sessionId: 'fixture-session',
      turn: 42 - Math.floor(i / 4),
      step: 1 + (i % 4),
      retry: 0,
      model: 'deepseek-flash',
      tokens: 34000 + i * 500,
      cacheMiss: 820 + i * 40,
      cacheHit: 33000 + i * 400,
      cacheWrite: 0,
      output: 260 + i * 12,
      reasoning: 0,
      cost: 0.0021 + i * 0.0001,
      tier: i === 3 ? 'peak' : 'off',
      estimated: false,
    });
  }
  return rows;
}

// 造一份完整的演示状态
export function makeFixtureState() {
  return {
    mode: 'reserved2', role: '小鲸鱼', roleMode: 'active', closedAgentPreset: '', paused: false,
    roles: ['小鲸鱼', '温柔助手', '技术伙伴'],
    roleContents: {
      小鲸鱼: '# 小鲸鱼\n\n- 性格：好奇、爱接梗，遇到不懂的会直接问\n- 说话风格：简短，偶尔用 emoji',
      温柔助手: '# 温柔助手\n\n- 性格：温和、有耐心\n- 说话风格：先共情再回答',
      技术伙伴: '# 技术伙伴\n\n- 性格：直接、爱讲原理\n- 说话风格：先给结论再解释',
    },
    simPrompts: {
      'qq-chat-v2': '你是 QQ 群里的仿真群友。\n\n【二代仿真模式 —— 安全规则（最高优先级，不可违反）】\n1. 你没有本地工具。\n\n【二代仿真模式 —— 工具协议（最高优先级）】\n1. 文本输出不会自动发送到 QQ。',
      'qq-chat': '你是 QQ 群里的仿真群友（一代）。\n\n【一代仿真模式 —— 安全规则】\n1. 你没有本地工具。\n\n【一代仿真模式 —— 工具协议】\n1. 回复会自动转发到 QQ。',
    },
    roleInjectMax: 8000,
    dshEffort: 'max',
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    gatePolicy: { mode: 'all', updatedAt: '2026-09-20T08:30:00.000Z', entries: [{ qq: '100002', flags: { respond: true, converse: true, context: true, memory: true }, aliases: ['演示群友'], note: '离线示例规则' }] },
    sessions: [
      { key: 'group:123456789', sessionId: 'demo-community-20260920', owner: false },
      { key: 'group:100003', sessionId: 'demo-development-20260920', owner: false },
      { key: 'private:100001', sessionId: 'demo-owner-20260920', owner: true },
    ],
    social: {
      triggerProbability: 0.2, activeCheckMinMs: 10000, activeCheckMaxMs: 30000,
      activeReplyDelayMinMs: 1000, activeReplyDelayMaxMs: 3000, activeDurationEnabled: true,
      activeDurationMinMs: 180000, activeDurationMaxMs: 600000, idleWindowMs: 300000,
      idleRetryProbability: 0.4, idleRetryWaitMs: 120000, skipProbability: 0.15,
      surrenderProbability: 0.08, contextWindow: 20, maxReplyChars: 500,
      burstEnabled: true, burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000,
      longGapProbability: 0.1, longGapMinMs: 2500, longGapMaxMs: 5000,
      mustReplyKeywords: ['小鲸鱼', 'DeepSeek'], proactiveEnabled: true,
      proactiveIdleThresholdMs: 1800000, proactiveCheckMinMs: 300000,
      proactiveCheckMaxMs: 900000, proactiveProbability: 0.2,
    },
    socialStates: { 'group:123456789': { phase: 'active' }, 'group:100003': { phase: 'idle' } },
    v2: { enabled: true, agentPreset: 'qq-chat-v2', provideRecommendations: true, tools: {} },
    // 会话初始提示词（离线示例）：整段内容都是虚构的演示文本。
    initPrompt: '离线示例：这是一个演示用的群聊环境说明，不会写进任何真实配置。',
    terms: [],
    security: { interceptNotify: true },
// 权限有没有收紧。离线演示默认不收紧，好让告警条显示出来
    // 。
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_recent_messages', type: 'result', ok: true },
    ],
    feedback: [{ time: timestamp, level: 'info', message: '这是离线演示反馈。' }],
  };
}

/** 只监听本机，改动只影响内存里的演示数据 */
export async function startConsoleFixture({ port = 0, htmlPath, logWrites = false } = {}) {
  const file = htmlPath || resolve(projectRoot, 'src/features/console/web/studio.html');
  await readFile(file); // 有问题早点报错，别显示一个坏掉的预览
  const state = makeFixtureState();
  const requests = [];
  const unknownRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = resolveApiPath(url.pathname).path;
    const method = req.method || 'GET';
    // 回一段 JSON 给网页
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (method === 'GET' && ['/', '/console', '/console.html'].includes(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'" });
        const pageFile = !htmlPath && url.searchParams.get('classic') === '1' ? resolve(projectRoot, 'src/features/console/web/console.html') : file;
        res.end(await readFile(pageFile, 'utf8'));
        return;
      }
      if (path === '/api/console/conversations') return json({ ok: true, writable: true, conversations: {} });
      if (path === '/api/console/system') return json({ ok: true, health: { dsh: true }, scheduler: { turns: {}, timers: [] }, queues: [], conversations: [], memory: { enabled: false, cursors: [] } });
      if (path === '/api/console/identity') return json({ ok: true, people: {}, updatedAt: '' });
      if (path === '/api/console/memory/long') return json({ ok: true, items: [], cursor: 0 });
      if (path === '/api/console/settings' || path === '/api/console/migration') return json({ ok: true, revision: 'fixture', migration: [], changes: [], running: {}, configured: { architecture: {}, modes: { engine: {}, defaults: {} } } });
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (method === 'GET' && path === '/__fixture/requests') return json({ requests, unknownRequests });
      if (method === 'GET' && path === '/__fixture/info') return json({ offline: true, htmlPath: file });
      if (!path.startsWith('/api/')) return json({ ok: false, error: 'Offline fixture route not found' }, 404);

      let body = {};
      if (method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requests.push({ method, path: url.pathname, body });
        if (logWrites) console.log(`[mock write] ${method} ${path} ${JSON.stringify(body)}`);
      }
      if (path === '/api/console/memory/terms') {
        if (method === 'GET') { const key = url.searchParams.get('key') || 'global'; return json({ ok: true, writable: true, items: state.terms.filter(item => item.conv_id === key || item.conv_id === 'global') }); }
        if (method === 'POST') state.terms.push({ id: 'term-' + state.terms.length, conv_id: body.key, content: body.content, meaning: body.meaning });
        if (method === 'DELETE') state.terms = state.terms.filter(item => item.conv_id !== body.key || item.content !== body.content);
        return json({ ok: true });
      }
      const policyBase = '/api/console/gate/member-policy';
      const policyResponse = () => ({ ok: true, group: 'group:123456789', mode: state.gatePolicy.mode, updatedAt: state.gatePolicy.updatedAt, updatedBy: 'console', gateV2: false, policyBroken: false, policyEpoch: 1, entries: state.gatePolicy.entries.map((entry) => ({ ...entry, effective: { allowed: true, reason: 'ok', flags: entry.flags, gate: { memberMode: state.gatePolicy.mode } } })) });
      if (method === 'GET' && path === policyBase) return json(policyResponse());
      if (method === 'GET' && path === `${policyBase}/export`) {
        if (url.searchParams.get('format') === 'csv') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
          res.end(`qq,respond,converse,context,memory,aliases,note\r\n${state.gatePolicy.entries.map((entry) => `${entry.qq},true,true,true,true,,${entry.note ?? ''}`).join('\r\n')}`);
          return;
        }
        return json(policyResponse());
      }
      if (method === 'GET' && path === `${policyBase}/effective`) return json({ ok: true, allowed: true, reason: 'ok', flags: { respond: true, converse: true, context: true, memory: true } });
      const policyMember = path.match(/^\/api\/console\/gate\/member-policy\/[^/]+\/members\/([^/]+)$/);
      if (method === 'PATCH' && policyMember) {
        const entry = state.gatePolicy.entries.find((item) => item.qq === policyMember[1]);
        if (entry) Object.assign(entry, body, { flags: { ...entry.flags, ...body.flags } });
        else state.gatePolicy.entries.push({ qq: policyMember[1], ...body });
        state.gatePolicy.updatedAt = new Date(Date.parse(state.gatePolicy.updatedAt) + 1000).toISOString();
        return json(policyResponse());
      }
      if (method === 'DELETE' && policyMember) {
        state.gatePolicy.entries = state.gatePolicy.entries.filter((entry) => entry.qq !== policyMember[1]);
        return json(policyResponse());
      }
      if (method === 'PUT' && /^\/api\/console\/gate\/member-policy\/[^/]+$/.test(path)) {
        state.gatePolicy.mode = body.mode;
        state.gatePolicy.entries = body.entries;
        state.gatePolicy.updatedAt = new Date(Date.parse(state.gatePolicy.updatedAt) + 1000).toISOString();
        return json(policyResponse());
      }
      if (method === 'POST' && path === `${policyBase}/import`) {
        if (body.dryRun) return json({ ok: true, dryRun: true, count: body.entries.length });
        state.gatePolicy.mode = body.mode;
        state.gatePolicy.entries = body.entries;
        return json(policyResponse());
      }
      if (method === 'GET') {
        switch (path) {
          case '/api/agent/status': return json({ ok: true, dshReady: true, mode: state.mode, role: state.role, roleMode: state.roleMode, closedAgentPreset: state.closedAgentPreset, ownerQQ: state.whitelist.ownerQQ, allowGroups: state.whitelist.allow.groups, allowPrivate: state.whitelist.allow.private, activity: '[08:30:00] 演示桥接已连接\n[08:30:12] group:123456789 · 已处理一条消息\n[08:30:20] 二代社交助手正在运行\n以上均为离线模拟数据。' });
          case '/api/console/presets': return json({ presets: [{ id: 'qq-chat-v2', trust: 'user' }, { id: 'qq-chat', trust: 'user' }] });
          case '/api/console/roles': return json({
            roles: state.roles.slice(),
            summaries: state.roles.map((name) => {
              const content = state.roleContents[name] ?? '';
              const stats = roleCharStats(content);
              const injectMax = state.roleInjectMax;
              return {
                name,
                bytes: Buffer.byteLength(content, 'utf8'),
                chars: content.length,
                lines: content.split('\n').length,
                mtime: Date.parse(timestamp),
                excerpt: content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) ?? '',
                injectedV1: Math.min(stats.v1, injectMax),
                injectedV2: Math.min(stats.v2, injectMax),
                charsV1: stats.v1,
                charsV2: stats.v2,
                hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
                truncated: stats.v1 > injectMax || stats.v2 > injectMax,
                warnings: 0,
              };
            }),
            current: state.role,
            limits: { nameMax: 40, contentMaxBytes: 65536, injectMaxChars: state.roleInjectMax },
          });
          case '/api/console/roles/content': {
            const name = url.searchParams.get('name') ?? '';
            if (!state.roleContents[name]) return json({ ok: false, error: `人格「${name}」不存在` }, 404);
            const content = state.roleContents[name];
            return json({
              ok: true,
              name,
              content,
              chars: content.length,
              bytes: Buffer.byteLength(content, 'utf8'),
              warnings: [],
              limits: { injectMaxChars: state.roleInjectMax },
              stats: roleCharStats(content),
              sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
            });
          }
          case '/api/console/preset/sim-prompt': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({
              ok: true,
              content: state.simPrompts[preset],
              chars: state.simPrompts[preset].length,
              bytes: Buffer.byteLength(state.simPrompts[preset], 'utf8'),
              warnings: [],
              status: presetStatusFixture(preset),
              presets: [presetStatusFixture('qq-chat'), presetStatusFixture('qq-chat-v2')],
            });
          }
          case '/api/console/preset/sim-prompt/backups': {
            const preset = url.searchParams.get('preset') === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, backups: [{ file: `${preset}.agent.cordis.yml.fixture`, mtime: Date.parse(timestamp) }] });
          }
          case '/api/console/dsh/model': return json({
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            reasoningEffort: state.dshEffort,
            options: ['low', 'medium', 'high', 'max', 'none'],
            labels: { low: { name: 'Low', description: 'routine' }, medium: { name: 'Medium', description: 'adapter-owned effort' }, high: { name: 'High', description: 'default balance' }, max: { name: 'Max', description: 'hardest tasks' } },
            default: 'max',
            providerDefault: 'high',
            catalogSource: 'dsh',
            globalSideEffect: true,
          });
          case '/api/console/whitelist': return json(state.whitelist);
          case '/api/console/sessions': return json({ sessions: state.sessions });
          case '/api/console/pending': return json({ pending: [{ key: 'group:123456789', kind: 'approval', toolName: '演示工具', reason: '等待管理员确认（离线示例）' }] });
          case '/api/console/social': return json({ config: state.social, states: state.socialStates, pendingSummaries: { 'group:123456789': 2 } });
          case '/api/agent/config': return json({ ok: true, config: state.v2 });
          case '/api/agent/activity': return json({ ok: true, paused: state.paused });
          case '/api/agent/tool-log': return json({ ok: true, entries: state.toolLog });
          case '/api/agent/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/agent/memory': return json({ ok: true, raw: { activeTopics: [{ text: '周末的阅读计划', pendingQuestion: '有没有推荐的书？' }], pendingThoughts: [{ text: '分享一张风景照片', motivation: '轻松交流' }], memberImpressions: { 演示群友: { traits: ['友善', '喜欢技术'], interactionCount: 6 } } } });
          case '/api/agent/state': return json({ ok: true, key: url.searchParams.get('key'), wakeConfig: { mode: 'diving', infinite: false, sleepUntil: '2026-09-20T09:00:00.000Z', triggers: { atMention: true, keywords: ['小鲸鱼'] }, wakeCount: 4 }, wakeSafety: { guaranteed: true }, unreadCount: 2, lastWakeReason: 'atMention' });
          case '/api/agent/states': return json({ ok: true, conversations: state.sessions.map(x => ({ key: x.key, phase: 'diving', unreadCount: 2 })) });
          case '/api/agent/initial-prompt': {
            const key = url.searchParams.get('key') || '';
            if (!key) {
              return json({
                ok: true,
                maxChars: 2000,
                writable: true,
                entries: state.initPrompt
                  ? [{ key: 'group:123456789', chars: String(state.initPrompt).length, updatedAt: Date.now(), preview: String(state.initPrompt).slice(0, 80) }]
                  : []
              });
            }
            return json({
              ok: true, key, exists: !!state.initPrompt, text: state.initPrompt || '',
              createdAt: Date.now(), updatedAt: Date.now(), maxChars: 2000, writable: true
            });
          }
          // 语音库（离线示例：不含任何真实音频路径）
          case '/api/console/voice/list':
          case '/api/agent/voices': return json({
            ok: true,
            key: url.searchParams.get('key') || 'group:123456789',
            count: 2,
            voices: [
              { name: '演示-问候.mp3', ok: true, bytes: 20480, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', seconds: 2 },
              { name: '演示-太长.wav', ok: false, bytes: 99999999, error: '时长 12分00秒 超过上限 5分00秒' },
            ],
            limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 },
            hint: '用 qq_send_voice 传 name 即可把其中一个当语音发出去',
          });
// 权限收紧的结果：用假数据演示「未收紧」的告警条
          case '/api/console/security': return json({
            ok: true,
            security: state.security,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: '/demo/qq-bridge/state', manualCommand: '' }
              : { hardened: false, path: '/demo/qq-bridge/state', manualCommand: manualDirCommand('/demo/qq-bridge/state') }
          });
          // 令牌与花费：全部为离线示例数据，不含任何真实用量。
          case '/api/console/tokens/summary': return json(usageSummaryFixture());
          case '/api/console/tokens/series': return json(usageSeriesFixture(url.searchParams.get('hours')));
          case '/api/console/tokens/turns': return json(usageTurnsFixture(url.searchParams.get('key')));
          case '/api/console/tokens/recent': return json({ ok: true, symbol: '¥', entries: usageRecentFixture() });
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/console/mode': state.mode = body.mode; state.closedAgentPreset = body.closedAgentPreset; return json({ ok: true, dshSynced: true });
          case '/api/console/role': state.role = body.role; return json({ ok: true });
          case '/api/console/roles/create': state.roles.push(body.name); state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, warnings: [] });
          case '/api/console/roles/update': state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, chars: String(body.content ?? '').length, warnings: [] });
          case '/api/console/roles/rename': {
            const idx = state.roles.indexOf(body.from);
            if (idx >= 0) state.roles[idx] = body.to;
            state.roleContents[body.to] = state.roleContents[body.from] ?? '';
            delete state.roleContents[body.from];
            if (state.role === body.from) state.role = body.to;
            return json({ ok: true, role: body.to, renamed: true, currentFollowed: state.role === body.to });
          }
          case '/api/console/roles/delete': {
            const idx = state.roles.indexOf(body.name);
            if (idx >= 0) state.roles.splice(idx, 1);
            delete state.roleContents[body.name];
            const cleared = state.role === body.name;
            if (cleared) state.role = null;
            return json({ ok: true, deleted: body.name, clearedCurrent: cleared });
          }
          case '/api/console/roles/limit': state.roleInjectMax = Number(body.maxInjectChars) || state.roleInjectMax; return json({ ok: true, maxInjectChars: state.roleInjectMax, limits: { injectMaxChars: state.roleInjectMax } });
          case '/api/console/preset/sim-prompt': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            const content = String(body.content ?? '');
            const unchanged = content === state.simPrompts[preset];
            if (!unchanged) state.simPrompts[preset] = content;
            return json({ ok: true, unchanged, chars: content.length, warnings: [], synced: true, requiresRestart: !unchanged, status: presetStatusFixture(preset) });
          }
          case '/api/console/preset/sim-prompt/restore': {
            const preset = body.preset === 'qq-chat' ? 'qq-chat' : 'qq-chat-v2';
            return json({ ok: true, restoredFrom: `${preset}.agent.cordis.yml.fixture`, requiresRestart: true });
          }
          case '/api/console/dsh/effort': state.dshEffort = body.reasoningEffort; return json({ ok: true, reasoningEffort: body.reasoningEffort });
          case '/api/console/role-mode': state.roleMode = body.mode; return json({ ok: true });
          case '/api/console/whitelist': state.whitelist = body; return json({ ok: true });
          case '/api/console/social': state.social = body; return json({ ok: true });
          case '/api/console/social/state': state.socialStates[body.key] = { phase: body.phase }; return json({ ok: true });
          case '/api/agent/config': state.v2 = body; return json({ ok: true });
          case '/api/agent/activity': state.paused = body.paused; return json({ ok: true });
          case '/api/agent/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/agent/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/agent/reset': return json({ ok: true });
          case '/api/agent/initial-prompt': {
            const text = body.delete === true ? '' : String(body.text ?? '');
            state.initPrompt = text;
            return json({
              ok: true, key: body.key || '', deleted: !text, chars: text.length,
              exists: !!text, updatedAt: Date.now(), maxChars: 2000
            });
          }
          case '/api/console/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: '/demo/qq-bridge/state' });
            }
            state.security = body;
            return json({ ok: true });
          case '/api/console/token': return json({ ok: true, token: body.token || 'offline-demo-token-123456', generated: !body.token });
          case '/api/console/test-send': return json({ ok: true, message_id: 'mock-message-001' });
          // 语音试发（操作者通道）：离线只回执，不产生任何真实 QQ 消息
          case '/api/console/voice/send': return json(body.dryRun
            ? { ok: true, dryRun: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3 · 24.0kHz · 单声道', verified: false }
            : { ok: true, target: body.target, file: body.file, detail: '2秒 · 20.0 KB · mp3', messageId: 9001, verified: true, limits: { maxSeconds: 300, maxBytes: 20971520, maxPerMinute: 2, maxPerHour: 10 } });
          case '/api/console/session/stop': return state.sessions.some(s => s.key === body.key) ? json({ ok: true, key: body.key, removed: 0 }) : json({ ok: false, error: '会话不存在' }, 404);
          case '/api/console/notify-ai': return json({ ok: true, sessionId: 'mock-dsh-session' });
          case '/api/console/restart': return json({ ok: true, message: '离线预览：已模拟重启，实际服务未改变。' });
          case '/api/console/workspace/reset': state.sessions = []; return json({ ok: true, archivedCount: 3 });
          case '/api/console/social/flush':
          case '/api/agent/wake':
          case '/api/agent/memory-clear':
          case '/api/agent/memory-update':
          case '/api/agent/memory-remove': return json({ ok: true });
          case '/api/console/tokens/reset': return json({ ok: true });
        }
      }
      unknownRequests.push({ method, path });
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // 从命令行参数里取某个选项的值
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
