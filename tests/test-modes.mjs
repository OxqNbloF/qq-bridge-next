import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { modeAdapters, getModeAdapter } from '../src/modes/registry.js';
import { resolveMode } from '../src/conversations/mode-router.js';
import { modeDependencyViolations, checkModeDependencies } from '../scripts/check-mode-dependencies.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createToolGate } from '../src/features/tools/gate.js';
import { createToolGateway, TOOL_ROUTES } from '../src/features/tools/gateway.js';
import { createMemoryAPI } from '../src/memory/api.js';

for (const engineEnabled of [false, true]) test(`F12 工具清单与网关共用能力矩阵且保留配置开关（engine=${engineEnabled}）`, async () => {
  for (const adapter of Object.values(modeAdapters)) {
    const key = 'group:456'; // 仅隔离能力矩阵；owner/会话准入由独立回归覆盖。
    const b = {
      cfg: { modes: { engine: { [adapter.id]: engineEnabled } }, socialV2: { tools: {} } },
      modeForKey: () => adapter.id, modeAdapterForKey: () => adapter,
      isSessionAllowedInCurrentMode: () => true, socialV2: {}, log() {},
      captureSendGuard: () => () => {},
    };
    Object.assign(b, createToolGate(b));
    const gateway = createToolGateway(b);
    for (const [route, [group, flag]] of Object.entries(TOOL_ROUTES)) {
      if (!flag) continue;
      const [method, path] = route.split(' ');
      const allowed = adapter.toolPolicy.groups.includes(group) && !adapter.toolPolicy.deny.includes(flag);
      const request = {
        req: { method, headers: { 'x-agent-call': '1', 'x-agent-token': 'fixture' } },
        url: new URL(path, 'http://offline.invalid'), tokenState: [path === '/api/agent/send/private' ? 'private:123' : key, {}],
        readBody: async () => ({ groupId: '456', userId: '123' }), sendJson() {},
      };
      assert.equal(b.toolFlagAllowed(key, flag), allowed, `${adapter.id}: ${flag}`);
      assert.equal(await gateway.authorizeToolRequest(request), allowed, route);
      b.cfg.socialV2.tools[flag] = false;
      assert.equal(b.toolFlagAllowed(key, flag), false, `disabled: ${flag}`);
      assert.equal(await gateway.authorizeToolRequest(request), false, `disabled: ${route}`);
      delete b.cfg.socialV2.tools[flag];
    }
    assert.equal(b.toolFlagAllowed(key, 'unknown-tool'), false);
  }
});

test('F12 memoryPolicy.write 保留五类兼容且逐类约束 API append', () => {
  const categories = ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias'];
  for (const adapter of Object.values(modeAdapters)) {
    let current = adapter;
    const writes = [];
    const b = {
      cfg: {}, modeAdapterForKey: () => current,
      getSocialV2State: () => ({ recentMessages: [] }),
      appendMemoryV2: (_state, category) => writes.push(category),
      terms: { append: () => writes.push('term') }, appendAlias: () => writes.push('alias'),
    };
    const api = createMemoryAPI(b);
    for (const category of categories) {
      api.append('group:456', category, '兼容写入', { target: '999' });
      assert.equal(writes.at(-1), category);
      current = { ...adapter, memoryPolicy: { ...adapter.memoryPolicy, write: categories.filter(kind => kind !== category) } };
      const count = writes.length;
      assert.throws(() => api.append('group:456', category, '策略禁止', { target: '999' }), error => error.statusCode === 403);
      assert.equal(writes.length, count, '被禁类别不得先写入后拒绝');
      current = adapter;
    }
    for (const category of ['event', 'preference', 'commitment', 'summary', 'unknown', '__proto__']) {
      assert.throws(() => api.append('group:456', category, '不得直接写入'), error => error.statusCode === 403);
    }
    current = null;
    assert.throws(() => api.append('group:456', 'term', '缺失模式策略'), error => error.statusCode === 403);
  }
});

test('F12 HTTP memory-update 不能绕过模式的类别写入限制', async () => {
  const h = await bridgeHarness();
  const adapter = getModeAdapter('chat');
  const original = adapter.memoryPolicy.write;
  let server;
  try {
    h.setMode('chat');
    h.memoryAPI.append('group:456', 'activeTopic', '原话题');
    const token = h.getSocialV2State('group:456').agentToken;
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    adapter.memoryPolicy.write = original.filter(category => category !== 'activeTopic');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/memory-update`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, 'x-agent-call': '1', 'x-agent-token': token },
      body: JSON.stringify({ key: 'group:456', category: 'activeTopic', oldContent: '原话题', newContent: '策略禁止修改' }),
    });
    assert.equal(response.status, 403);
    assert.equal(h.getSocialV2State('group:456').activeTopics[0].text, '原话题');
  } finally {
    adapter.memoryPolicy.write = original;
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('F12 网关令牌及调用标记强制鉴权不由模式控制，保留 status 例外', async () => {
  const gateway = createToolGateway({ log() {} });
  for (const route of Object.keys(TOOL_ROUTES)) {
    const [method, path] = route.split(' ');
    const request = {
      req: { method, headers: { 'x-agent-call': '1' } },
      url: new URL(path, 'http://offline.invalid'), readBody: async () => ({}), sendJson() {},
    };
    assert.equal(await gateway.authorizeToolRequest(request), path === '/api/agent/status', route);
    request.req.headers['x-agent-token'] = 'invalid';
    assert.equal(await gateway.authorizeToolRequest(request), false, `invalid: ${route}`);
    request.tokenState = ['group:456', {}];
    delete request.req.headers['x-agent-call'];
    assert.equal(await gateway.authorizeToolRequest(request), false, `missing call marker: ${route}`);
  }
});

test('F17 出站先限频后令牌审计，拒绝不消耗额度', async () => {
  const h = await bridgeHarness({ config: { modes: { engine: { reserved2: true } }, socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 0 } } } });
  try {
    h.setMode('reserved2');
    await h.sendMessagesV2('group:456', ['占额度'], [], null);
    const token = h.getSocialV2State('group:456').agentToken;
    await assert.rejects(h.sendMessagesV2('group:456', [token], [], null), error => error.statusCode === 429);
  } finally { await h.close(); }
});

test('F17 排队后长度收紧整批拒绝且回滚，legacy 工具同样生效', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, socialV2: { send: { maxMessageChars: 500, maxSendPerMinute: 2, maxSendPerHour: 0 } } } });
  try {
    h.setMode('reserved2');
    const blocker = h.enqueueOutbound('group:456', { text: '系统', channel: 'system', beforeDelay: 20 });
    const pending = h.sendMessagesV2('group:456', ['短', '太长了'], [], null);
    h.cfg.socialV2.send.maxMessageChars = 2;
    await blocker;
    await assert.rejects(pending, /不能超过 2 字/);
    assert.equal(h.calls.http.filter(call => /send_group_msg$/.test(call.url)).length, 0);
    assert.equal(h.getSocialV2State('group:456').sendTimes.length, 0);
    await h.sendMessagesV2('group:456', ['可', '以'], [], null);
    assert.equal(h.getSocialV2State('group:456').sendTimes.length, 2);
  } finally { await h.close(); }
});

test('F17 批次无效引用必须在第一条前拒绝，超大负消息号精确保留', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await assert.rejects(h.sendMessagesV2('group:456', ['第一', '第二'], [], 'invalid'), /非零整数/);
    assert.equal(h.calls.http.filter(call => /send_group_msg$/.test(call.url)).length, 0);
    await h.sendMessagesV2('group:456', ['有效'], [], '-9007199254740993123');
    const call = h.calls.http.filter(call => /send_group_msg$/.test(call.url)).at(-1);
    assert.equal(call.body.message[0].data.id, '-9007199254740993123');
  } finally { await h.close(); }
});

test('F17 HTTP 各文本入口统一先限频后长度/引用，失败归还额度', async () => {
  const h = await bridgeHarness({ config: { socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 0, maxMessageChars: 2 } } } });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'group:456', st = h.getSocialV2State(key);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    for (const [path, body] of [
      ['send/group', { groupId: '456', message: '太长了', replyToMessageId: 'invalid' }],
      ['send-message', { key, messages: ['太长了'], replyToMessageId: 'invalid' }],
      ['send-burst', { key, messages: ['太长了'], replyToMessageId: 'invalid' }],
    ]) {
      st.sendTimes = [Date.now()];
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken,
          'x-agent-call': '1', 'x-agent-token': st.agentToken }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 429, `${path}: ${JSON.stringify(await response.json())}`);
      assert.equal(st.sendTimes.length, 1);
    }
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('F17 普通/时间线原始整包进入出站，令牌拆段不得发送', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    h.setMode('chat');
    const token = h.getSocialV2State('group:456').agentToken;
    await h.sendToQQ('group:456', token, { ai: true });
    assert.equal(h.calls.sent.length, 0);
    h.setMode('reserved');
    const fragments = token.match(/.{1,2}/g);
    const sent = await h.sendBurstToQQ('group:456', fragments, 0, 0);
    assert.deepEqual(sent, []);
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('F17 时间线在出站执行时按最新长度拆分，整批占一个 FIFO 槽', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, social: { maxReplyChars: 20 } } });
  try {
    h.setMode('reserved');
    const blocker = h.enqueueOutbound('group:456', { text: '系统', channel: 'system', beforeDelay: 20 });
    const burst = h.sendBurstToQQ('group:456', ['一二三四', '五六'], 0, 0);
    const later = h.sendToQQ('group:456', '随后');
    h.cfg.social.maxReplyChars = 2;
    await Promise.all([blocker, burst, later]);
    assert.deepEqual(h.calls.sent.map(call => call.text), ['系统', '一二', '三四', '五六', '随后']);
  } finally { await h.close(); }
});

test('F17 拍一拍先限频再验证成员且失败不占额度', async () => {
  const h = await bridgeHarness({ config: { socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 0 } } } });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'group:456', st = h.getSocialV2State(key);
    st.sendTimes = [Date.now()];
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/send-poke`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken,
        'x-agent-call': '1', 'x-agent-token': st.agentToken }, body: JSON.stringify({ key, targetUserId: 'all' }),
    });
    assert.equal(response.status, 429, JSON.stringify(await response.json()));
    assert.equal(st.sendTimes.length, 1);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('F17 自动文本与工具共享引擎限频，工具预占账本不重复扣', async () => {
  const h = await bridgeHarness({ config: { modes: { engine: { 'closed-agent': true } }, sendDelayMs: 0,
    socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 0 } } } });
  try {
    h.setMode('closed-agent');
    await h.sendToQQ('private:123', '自动回复', { ai: true });
    await assert.rejects(h.sendMessagesV2('private:123', ['工具回复'], [], null, null, 'sendPrivate'), error => error.statusCode === 429);
    assert.equal(h.getSocialV2State('private:123').sendTimes.length, 0);
  } finally { await h.close(); }
});

test('F17 legacy 排队期间工具开关撤销仍复查', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    h.setMode('reserved2');
    const blocker = h.enqueueOutbound('group:456', { text: '系统', channel: 'system', beforeDelay: 20 });
    const pending = h.sendMessagesV2('group:456', ['不可发送'], [], null);
    h.cfg.socialV2.tools.sendMessage = false;
    await blocker;
    await assert.rejects(pending, /工具未启用/);
    assert.equal(h.calls.http.filter(call => /send_group_msg$/.test(call.url)).length, 0);
    assert.equal(h.getSocialV2State('group:456').sendTimes.length, 0);
  } finally { await h.close(); }
});

test('F17 分条间长度策略收紧不得发送旧计划超长段，保留已发回执', async () => {
  const h = await bridgeHarness({ config: { social: { maxReplyChars: 20 }, sendDelayMs: 0 } });
  try {
    h.setMode('reserved');
    const send = h.bot.sendGroupMessage.bind(h.bot);
    h.bot.sendGroupMessage = async (...args) => { await send(...args); h.cfg.social.maxReplyChars = 2; };
    const sent = await h.sendBurstToQQ('group:456', ['甲', '一二三四'], 0, 0);
    assert.deepEqual(sent, ['甲']);
    assert.deepEqual(h.calls.sent.map(call => call.text), ['甲']);
    assert.equal(h.lastSendSucceeded('group:456'), false);
  } finally { await h.close(); }
});

const enabled = Object.fromEntries(Object.keys(modeAdapters).map((id) => [id, true]));
const flags = { respond: true, context: true, converse: true, memory: true };
const message = (text = '你好') => ({ message_type: 'group', group_id: 456, user_id: 999, self_id: 888, message_id: 100, sender: { card: '小明' }, message: [{ type: 'text', data: { text } }] });
const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (config = {}) => bridgeHarness({ config: { modes: { engine: enabled }, sendDelayMs: 0, social: { proactiveEnabled: false, activeReplyDelayMinMs: 0, activeReplyDelayMaxMs: 0 }, socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } }, ...config } });

test('四模式统一接口、共享能力与发送/权限差异', () => {
  assert.equal(getModeAdapter('__proto__'), null);
  assert.deepEqual(Object.values(modeAdapters).map((a) => a.sendPolicy.mode), ['auto-text', 'auto-text', 'timeline', 'tools-only']);
  for (const adapter of Object.values(modeAdapters)) {
    for (const hook of ['decide', 'buildPrompt', 'onTurnStart', 'onTurnEnd']) assert.equal(typeof adapter[hook], 'function');
    assert.deepEqual(adapter.memoryPolicy.read, ['light', 'terms', 'long']);
    assert.ok(adapter.capabilities.schedule.length > 0);
    assert.equal('requireToken' in adapter.toolPolicy, false, '令牌鉴权是网关不变量，不提供模式开关');
    assert.equal('audit' in adapter.toolPolicy, false, '发送审计由 sendPolicy 声明');
    assert.equal(adapter.toolPolicy.allowed === 'full', adapter.capabilities.permission === 'owner-private');
    assert.equal(adapter.onTurnEnd({}, { reason: { kind: 'completed' }, text: '你好' })?.mode ?? null, adapter.id === 'reserved2' ? null : adapter.sendPolicy.mode);
    assert.equal(adapter.onTurnEnd({}, { reason: { kind: 'error' }, text: '' }), null);
  }
});

test('纯决策覆盖回应开关、概率、活跃批量、退场、bootstrap、潜水触发', () => {
  const evt = Object.freeze({ flags: Object.freeze(flags), kind: 'group', direct: false, random: 0.2, probability: 0.15 });
  assert.equal(modeAdapters.chat.decide({ flags: { respond: false } }).action, 'drop');
  assert.equal(modeAdapters.reserved.decide(evt, Object.freeze({ phase: 'idle' })).action, 'defer');
  assert.equal(modeAdapters.reserved.decide({ ...evt, direct: true }, { phase: 'idle' }).action, 'wake');
  assert.equal(modeAdapters.reserved.decide({ ...evt, random: 0.1 }, { phase: 'idle' }).strategy, 'probability');
  assert.equal(modeAdapters.reserved.decide(evt, { phase: 'active' }).strategy, 'batched');
  assert.equal(modeAdapters.reserved.decide({ ...evt, kind: 'private' }, { phase: 'active' }).action, 'wake');
  assert.equal(modeAdapters.reserved.decide(evt, { phase: 'exiting' }).action, 'defer');
  assert.equal(modeAdapters.reserved2.decide(evt, {}).reason, 'bootstrap');
  assert.equal(modeAdapters.reserved2.decide({ ...evt, reason: 'timeout' }, { bootstrapSent: true }).action, 'wake');
  assert.equal(modeAdapters.reserved2.decide({ ...evt, paused: true }, {}).action, 'drop');
});

test('会话 > 类型 > 全局路由，closed-agent 仅 owner 私聊', () => {
  const cfg = { globalMode: 'chat', ownerQQ: 123, enabled, defaults: { group: 'reserved' }, overrides: { 'group:456': { mode: 'reserved2' } } };
  assert.deepEqual(resolveMode('group:456', cfg), { mode: 'reserved2', source: 'conversation' });
  assert.deepEqual(resolveMode('group:789', cfg), { mode: 'reserved', source: 'type' });
  assert.deepEqual(resolveMode('private:789', cfg), { mode: 'chat', source: 'global' });
  for (const key of ['group:456', 'private:789']) assert.equal(resolveMode(key, { ...cfg, overrides: { [key]: { mode: 'closed-agent' } } }).mode, null);
  assert.equal(resolveMode('private:123', { ...cfg, overrides: { 'private:123': { mode: 'closed-agent' } } }).mode, 'closed-agent');
  assert.equal(resolveMode('private:123', { ...cfg, defaults: { private: 'closed-agent' } }).mode, null);
  assert.deepEqual(resolveMode('group:456', { ...cfg, enabled: {} }), { mode: 'chat', source: 'global' });
});

test('仅预设/模型的覆盖不冒充会话模式来源', () => {
  const cfg = { globalMode: 'chat', enabled, overrides: { 'group:456': { preset: 'qq-chat', model: 'fixture' } } };
  assert.deepEqual(resolveMode('group:456', cfg), { mode: 'chat', source: 'global' });
  assert.deepEqual(resolveMode('group:456', { ...cfg, defaults: { group: 'reserved' } }), { mode: 'reserved', source: 'type' });
  assert.deepEqual(resolveMode('group:456', { ...cfg, overrides: { 'group:456': { mode: null } } }), { mode: 'chat', source: 'global' });
});

test('依赖检查覆盖真实发送和会话 API，不把只读 bot 查询误报', () => {
  for (const source of [
    'ctx.bot.sendGroupMessage(456, text)', 'bot.sendPrivateMessage(123, text)', 'b.bot?.sendMessage(text)',
    'b.onebotHttpAction(action, params)', 'b.api.sessions.prompt(id, request)', 'api . sessions . create({})',
    "import { x } from 'pkg/modes/chat.js'",
  ]) assert.ok(modeDependencyViolations('reserved.js', source).length, source);
  assert.deepEqual(modeDependencyViolations('reserved.js', 'bot.getGroupInfo(456); api.settings.describe()'), []);
});

for (const engineEnabled of [false, true]) test(`tools-only 是出站契约，区分模型文本与系统/控制台通知（engine=${engineEnabled}）`, async () => {
  const h = await bridgeHarness({ config: { modes: { engine: { reserved2: engineEnabled } }, sendDelayMs: 0 } });
  try {
    h.setMode('reserved2');
    for (const intent of [
      { channel: 'auto-text', ai: true }, { channel: 'auto-text', ai: false },
      { channel: 'timeline', ai: true }, { channel: 'system', ai: true },
    ]) await assert.rejects(h.enqueueOutbound('group:456', { text: 'must not leak', ...intent }), /只允许工具发送/);
    assert.equal(h.calls.sent.length, 0);
    await h.enqueueOutbound('group:456', { text: 'system notice', channel: 'system', ai: false });
    await h.enqueueOutbound('group:456', { text: 'operator message', channel: 'console', ai: false, explicitAllow: true });
    await h.sendMessagesV2('group:456', ['tool message'], [0], null);
    assert.equal(h.calls.sent.length, 2);
    assert.equal(h.calls.http.filter(call => /send_group_msg$/.test(call.url)).length, 1);
  } finally { await h.close(); }
});

test('HTTP 文本工具发送经真实 onSent 恰好归档一次，保留引用与消息号', async () => {
  const h = await fixture({ memory: { archive: { enabled: true } } });
  try {
    h.setMode('reserved2');
    await h.sendMessagesV2('group:456', ['tool text'], [0], '-123');
    const rows = h.messageArchive.range('group:456').filter(row => row.from === 'bot');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows.map(row => row.text), ['tool text']);
    assert.equal(rows[0].reply_to, '-123');
    assert.equal(rows[0].msg_id, 'bot-9001');
    await assert.rejects(h.sendMessagesV2('group:456', ['failed text'], [0], 'invalid-id'));
    assert.equal(h.messageArchive.range('group:456').filter(row => row.from === 'bot').length, 1);
  } finally { await h.close(); }
});

test('实际源码依赖方向，拒绝跨模式/存储/传输/定时器', () => {
  assert.deepEqual(checkModeDependencies(), []);
  for (const source of ["import { x } from '../store/x.js'", "import('../gateway/x.js')", "import { x } from './chat.js'", 'ctx.ensureSession()', 'setTimeout(run, 1)']) assert.ok(modeDependencyViolations('reserved.js', source).length, source);
  const filter = fs.readFileSync(new URL('../src/inbound/filter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(filter, /if \(.*(?:===|!==) '(?:chat|reserved2?)'/);
});

for (const mode of Object.keys(modeAdapters)) test(`${mode} 共用记忆和调度，保持实际回合发送策略`, async () => {
  const h = await fixture();
  try {
    h.setMode(mode); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
    h.getSocialV2State(key).activeTopics = [{ text: '模式共享记忆', lastMentionAt: Date.now() }];
    await h.deliverPrompt(key, '测试普通投递');
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('模式共享记忆'));
    assert.equal(h.schedulerEnabled(key), true);
    const sid = h.state.sessions[key];
    const sent = h.calls.sent.length;
    const frames = ['turn/start', 'assistant/message', 'turn/end'].map((type) => ({ payload: {
      type: 'session/event', sessionId: sid, event: { type, data: { turn: 't1',
        ...(type === 'assistant/message' ? { message: { content: [{ type: 'text', text: '模式回复' }] } } : {}),
        ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}),
      } },
    } }));
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] } } }) };
    h.api.events.mux = async function* () { yield* frames; await new Promise(() => {}); };
    void h.pumpMux();
    await wait();
    assert.equal(h.calls.sent.length > sent, mode !== 'reserved2');
  } finally { await h.close(); }
});

test('切换撤销旧会话/排队/令牌，保留记忆、不干扰别群', async () => {
  const h = await fixture({ allow: { groups: ['456', '789'], private: ['123'] } });
  try {
    h.setMode('chat'); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    const key = 'group:456', st = h.getSocialV2State(key), token = st.agentToken;
    st.activeTopics = [{ text: '切换后仍记得', lastMentionAt: Date.now() }];
    await h.deliverPrompt(key, '旧工作');
    const old = h.state.sessions[key], other = await h.ensureSession('group:789');
    await h.deliverPrompt(key, '排队的旧工作');
    h.setConversationOverride(key, { mode: 'reserved2' }, 'console');
    assert.deepEqual(h.resolveConversationMode(key), { mode: 'reserved2', source: 'conversation' });
    assert.equal(h.getMode(), 'chat');
    assert.equal(h.state.sessions[key], undefined);
    assert.equal(h.state.sessions['group:789'], other);
    assert.equal(h.turnEngine.stats(key).queueDepth, 0);
    assert.ok(h.conversationEpoch(key) > 0);
    assert.notEqual(st.agentToken, token);
    assert.ok(h.buildModeMemory(key).includes('切换后仍记得'));
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'qq-chat' }, { id: 'qq-chat-v2' }, { id: 'standard', isDefault: true }] } } }) };
    h.api.events.mux = async function* () {
      for (const type of ['turn/start', 'assistant/message', 'turn/end']) yield { payload: { type: 'session/event', sessionId: old, event: { type, data: { turn: 'late', message: { content: [{ type: 'text', text: '迟到回复' }] }, reason: { kind: 'completed' } } } } };
      await new Promise(() => {});
    };
    void h.pumpMux(); await wait();
    assert.equal(h.calls.sent.length, 0);
    h.deleteConversationOverride(key, 'console');
    assert.equal(h.modeForKey(key), 'chat');
    assert.ok(h.buildModeMemory(key).includes('切换后仍记得'));
  } finally { await h.close(); }
});

test('全局 chat 的群覆盖 reserved2：实际入站走二代适配器', async () => {
  const h = await fixture();
  try {
    h.setMode('chat'); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    h.setConversationOverride('group:456', { mode: 'reserved2' }, 'console');
    h.getSocialV2State('group:456').wakeConfig.batchWindowMs = 1000;
    await h.handleIncoming('group', 456, message(), h.cfg);
    assert.equal(h.turnEngine.stats('group:456').state, 'batching');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(h.getSocialV2State('group:456').unread.length, 1);
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /引导唤醒/);
    assert.equal(h.social.states.size, 0);
  } finally { await h.close(); }
});

test('一代概率决策穿过延迟投递边界仍保持 message/probability', async () => {
  const h = await fixture({ social: { proactiveEnabled: false, triggerProbability: 1, activeReplyDelayMinMs: 40, activeReplyDelayMaxMs: 40 } });
  try {
    h.setMode('reserved');
    await h.handleIncoming('group', 456, message('普通闲聊'), h.cfg);
    const queued = h.turnEngine.snapshot().conversations.find(item => item.conv === 'group:456').queue;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].request.trigger.strategy, 'probability');
    assert.equal(queued[0].request.trigger.kind, 'message');
    assert.equal(queued[0].request.trigger.reason, 'probability');
    await wait(60);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.turnEngine.activeRequest('group:456').trigger.strategy, 'probability');
  } finally { await h.close(); }
});

test('一代活跃私聊的 batched 决策不会被延迟边界改成 timer', async () => {
  const h = await fixture({ social: { proactiveEnabled: false, activeReplyDelayMinMs: 40, activeReplyDelayMaxMs: 40 } });
  try {
    h.setMode('reserved');
    const st = h.socialState('private:123');
    st.phase = 'active'; st.activeStartedAt = Date.now();
    await h.handleIncoming('private', 123, { ...message('继续聊'), message_type: 'private', user_id: 123 }, h.cfg);
    const queued = h.turnEngine.snapshot().conversations.find(item => item.conv === 'private:123').queue;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].request.trigger.strategy, 'batched');
    assert.equal(queued[0].request.trigger.kind, 'message');
  } finally { await h.close(); }
});

test('一代使用会话边界定时器，不启动全局5秒心跳', async () => {
  const h = await fixture();
  try {
    h.setMode('reserved'); h.setReady(true); h.setPresets(['qq-chat']);
    await h.handleIncoming('group', 456, message('@888 你好'), h.cfg); await wait();
    assert.equal(h.social.loopTimer, null);
    assert.equal(h.socialState('group:456').phase, 'active');
    assert.equal(h.social.pendingTimers.size, 0);
    assert.equal(h.calls.prompts.length, 1);
    h.cancelSocialTimers('group:456'); h.retireSession('group:456');
  } finally { await h.close(); }
});

test('记忆预算和会话隔离', async () => {
  const h = await fixture();
  try {
    h.setMode('chat');
    h.getSocialV2State('group:456').pendingThoughts = Array.from({ length: 20 }, (_, i) => ({ text: `${i}本群记忆${'字'.repeat(150)}` }));
    h.getSocialV2State('private:123').activeTopics = [{ text: '管理员私密话题' }];
    assert.ok(h.buildModeMemory('group:456').length <= 800);
    assert.doesNotMatch(h.buildModeMemory('group:456'), /管理员私密话题/);
    assert.ok(h.buildModeMemory('private:123').includes('管理员私密话题'));
  } finally { await h.close(); }
});

test('模式灰度默认全关，类型默认不允许获得全工具权限', async () => {
  const { loadConfig } = await import('../src/infra/config.js');
  const load = (value) => loadConfig({ configFile: '/fixture', readJsonSafe: () => value, discoverDshLaunchToken: () => '' });
  assert.deepEqual(load({}).modes.engine, Object.fromEntries(Object.keys(enabled).map((id) => [id, false])));
  assert.equal(load({ modes: { engine: { chat: 'true', reserved: true } } }).modes.engine.chat, false);
  assert.equal(load({ modes: { engine: { reserved: true } } }).modes.engine.reserved, true);
  assert.throws(() => load({ modes: { defaults: { group: 'closed-agent' } } }), /只允许/);
  assert.throws(() => load({ modes: { defaults: { private: 'unknown' } } }), /只允许/);
});

test('混合模式 HTTP 工具按令牌所属会话判定，不能跨会话借用', async () => {
  const h = await fixture();
  let server;
  try {
    h.setMode('chat'); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    h.setConversationOverride('group:456', { mode: 'reserved2' }, 'console');
    const st = h.getSocialV2State('group:456');
    const token = st.agentToken;
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const call = (key) => fetch(`http://127.0.0.1:${server.address().port}/api/agent/unread?key=${key}`, { headers: { 'x-console-token': h.cfg.consoleToken, 'x-agent-call': '1', 'x-agent-token': token } });
    assert.equal((await call('group:456')).status, 200);
    assert.equal((await call('private:123')).status, 403);
    h.deleteConversationOverride('group:456', 'console');
    assert.equal((await call('group:456')).status, 403, '模式切换撤销旧令牌');
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('全局模式切换保留显式模式会话的在途工作', async () => {
  const h = await fixture({ allow: { groups: ['456', '789'], private: ['123'] } });
  let server;
  try {
    h.setMode('chat'); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    h.setConversationOverride('group:456', { mode: 'reserved2' }, 'console');
    await h.deliverPrompt('group:456', '显式模式工作');
    const sid = h.state.sessions['group:456'];
    await h.deliverPrompt('group:789', '全局模式工作');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/mode`, { method: 'POST', headers: { 'x-console-token': h.cfg.consoleToken, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reserved' }) });
    assert.equal(response.status, 200);
    assert.equal(h.state.sessions['group:456'], sid);
    assert.equal(h.turnEngine.stats('group:456').state, 'running');
    assert.equal(h.state.sessions['group:789'], undefined);
    assert.equal(h.modeForKey('group:789'), 'reserved');
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('被关闭的模式覆盖不借全局已启用模式应用其 preset/model', async () => {
  const h = await fixture({ modes: { engine: { chat: true } } });
  try {
    h.setMode('chat'); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    h.setConversationOverride('private:123', { mode: 'closed-agent', preset: 'standard', model: 'disabled-model' }, 'console');
    assert.deepEqual(h.resolveConversationMode('private:123'), { mode: 'chat', source: 'global' });
    await h.deliverPrompt('private:123', '普通聊天');
    assert.match(h.sessionPolicy('private:123'), /qq-chat/);
    assert.doesNotMatch(h.sessionPolicy('private:123'), /standard|disabled-model/);
  } finally { await h.close(); }
});

for (const mode of ['chat', 'reserved']) test(`${mode} 同策略退役保留普通及延迟队列，常规退役仍取消`, async () => {
  const h = await fixture();
  try {
    const key = 'group:456';
    h.setMode(mode); h.setReady(false);
    await h.deliverPrompt(key, '保留的普通消息');
    if (mode === 'reserved') h.scheduleSocialReply(key, '保留的延迟消息', 10000, 10000, 'fixture');
    const depth = mode === 'reserved' ? 2 : 1;
    assert.equal(h.turnEngine.stats(key).queueDepth, depth);
    h.retireSession(key, { preserveQueue: true });
    assert.equal(h.turnEngine.stats(key).queueDepth, depth);
    h.setReady(true); await h.turnEngine.replay(); await wait();
    assert.match(h.calls.prompts[0].content[0].text, /保留的普通消息/);
    assert.equal(h.turnEngine.stats(key).queueDepth, depth - 1);
    h.retireSession(key);
    assert.equal(h.turnEngine.stats(key).queueDepth, 0);
    assert.equal(h.turnEngine.stats(key).state, 'idle');
  } finally { await h.close(); }
});

for (const wakeReminder of [false, true]) test(`DSH 会话不存在时重建${wakeReminder ? '收尾提醒' : '唤醒'}，保留后续队列并发送新 token`, async () => {
  const h = await fixture({ socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } });
  try {
    const key = 'group:456';
    h.setMode('reserved2');
    const old = await h.ensureSession(key);
    // 清模型缓存后恢复旧映射，模拟本地绑定仍有效、远端已删除的会话。
    h.retireSession(key, { preserveQueue: true });
    h.state.sessions[key] = old;
    h.state.sessionPolicies[key] = h.sessionPolicy(key);
    h.reverse.set(old, key);
    const st = h.getSocialV2State(key), token = st.agentToken;
    const prompt = wakeReminder ? h.buildWakeReminderPromptV2(key) : h.buildWakePromptV2(key, 'bootstrap');
    let selections = 0;
    h.api.sessions.selectModel = async () => {
      if (++selections === 1) throw new Error('session not-found');
      return { result: { ok: true, value: { selected: { provider: 'fixture', model: 'fixture' } } } };
    };
    h.setReady(false);
    await h.deliverPrompt(key, prompt, wakeReminder ? { wakeReminder: true } : { wakeReason: 'bootstrap' });
    await h.deliverPrompt(key, '重建后第二条');
    assert.equal(h.turnEngine.stats(key).queueDepth, 2);
    h.setReady(true); await h.turnEngine.replay(); await wait();
    assert.equal(h.calls.created.length, 2);
    assert.notEqual(st.agentToken, token);
    assert.equal(h.calls.prompts.length, 1);
    const text = h.calls.prompts[0].content[0].text;
    assert.ok(text.includes(st.agentToken));
    assert.ok(!text.includes(token));
    assert.match(text, wakeReminder ? /【提醒】/ : /引导唤醒/);
    assert.equal(h.turnEngine.stats(key).queueDepth, 1);
    const sid = h.state.sessions[key];
    h.turnEngine.event(key, sid, { type: 'turn/start', data: { turn: 'rebuilt' } });
    h.turnEngine.settle(key, sid, 'rebuilt');
    await wait();
    assert.equal(h.calls.prompts.length, 2);
    assert.match(h.calls.prompts[1].content[0].text, /重建后第二条/);
  } finally { await h.close(); }
});

for (const path of ['console', 'prompt', 'outbox']) test(`${path} 预构建令牌在 not-found 重建及补投后使用当前值`, async () => {
  const h = await fixture(path === 'outbox' ? { modes: { engine: {} } } : {});
  let server;
  try {
    const key = 'group:456';
    h.setMode('reserved2');
    const old = await h.ensureSession(key);
    h.retireSession(key, { preserveQueue: true });
    h.state.sessions[key] = old;
    h.state.sessionPolicies[key] = h.sessionPolicy(key);
    h.reverse.set(old, key);
    const st = h.getSocialV2State(key), token = st.agentToken;
    let selections = 0;
    h.api.sessions.selectModel = async () => {
      if (++selections === 1) throw new Error('session not-found');
      return { result: { ok: true, value: { selected: { provider: 'fixture', model: 'fixture' } } } };
    };
    if (path === 'console') {
      h.turnEngine.pause(key);
      server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/notify-ai`, {
        method: 'POST', headers: { 'x-console-token': h.cfg.consoleToken, 'content-type': 'application/json' },
        body: JSON.stringify({ key, message: '后台令牌回归' }),
      });
      assert.equal(response.status, 200);
      assert.equal(h.turnEngine.stats(key).queueDepth, 1);
      h.turnEngine.resume(key); await wait();
    }
    if (path !== 'console') {
      h.setReady(false);
      await h.deliverPrompt(key, `【会话令牌】${token}（工具权限）\n普通令牌回归`);
      assert.equal(h.calls.prompts.length, 0);
      h.setReady(true);
      if (path === 'outbox') await h.flushQueue();
      if (path === 'prompt') await h.turnEngine.replay();
      await wait();
    }
    assert.equal(h.calls.created.length, 2);
    assert.notEqual(st.agentToken, token);
    assert.equal(h.calls.prompts.length, 1);
    const text = h.calls.prompts[0].content[0].text;
    assert.ok(text.includes(`【会话令牌】${st.agentToken}`));
    assert.ok(!text.includes(token));
    assert.match(text, path === 'console' ? /后台令牌回归/ : /普通令牌回归/);
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('无 sessionId 的退役也持久化策略删除且保留其他会话', async () => {
  const h = await fixture();
  try {
    const key = 'group:456', file = `${h.temp}/state/sessions.json`;
    h.state.sessionPolicies[key] = 'orphan-policy';
    h.state.sessionPolicies['group:789'] = 'retained-policy';
    fs.writeFileSync(file, JSON.stringify(h.state));
    h.retireSession(key);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.sessionPolicies[key], undefined);
    assert.equal(stored.sessionPolicies['group:789'], 'retained-policy');
  } finally { await h.close(); }
});

// 离线固定收发契约：真正经过入站管线、DSH 接纳及回合事件泵。
for (const sample of JSON.parse(fs.readFileSync(new URL('./fixtures/mode-golden.json', import.meta.url), 'utf8'))) test(`${sample.mode} 固定收发样本`, { timeout: 30_000 }, async () => {
  const h = await fixture({ social: { activeReplyDelayMinMs: 1, activeReplyDelayMaxMs: 1 }, socialV2: { wake: { batchWindowMs: 1000, maxWakePerMinute: 0, maxWakePerHour: 0 } } });
  try {
    h.setMode(sample.mode); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    await h.handleIncoming(sample.kind, sample.key.split(':')[1], {
      post_type: 'message', message_type: sample.kind, self_id: 10002, group_id: 456,
      user_id: sample.kind === 'private' ? 123 : 999, message_id: 88001,
      sender: { nickname: '样本成员', card: '样本成员' },
      message: [{ type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: sample.input } }],
    }, h.cfg);
    const deadline = Date.now() + 15_000;
    while (!h.calls.prompts.length && Date.now() < deadline) await wait(10);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.created[0].agentPreset, sample.preset);
    assert.ok(h.calls.prompts[0].content[0].text.includes(sample.input));
    const sid = h.state.sessions[sample.key];
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: sample.mode } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: ['standard', 'qq-chat', 'qq-chat-v2'].map(id => ({ id, isDefault: id === 'standard' })) } } }) };
    let eventsDone;
    const processed = new Promise(resolve => { eventsDone = resolve; });
    h.api.events.mux = async function* () {
      for (const [type, data] of [
        ['turn/start', {}], ['assistant/message', { message: { content: [{ type: 'text', text: sample.reply }] } }], ['turn/end', { reason: { kind: 'completed' } }],
      ]) yield { payload: { type: 'session/event', sessionId: sid, event: { type, data: { turn: 'golden', ...data } } } };
      eventsDone();
      await new Promise(() => {});
    };
    void h.pumpMux();
    await processed;
    assert.deepEqual(h.calls.sent.filter(item => item.text === sample.reply).map(item => item.text), sample.automatic ? [sample.reply] : []);
  } finally { await h.close(); }
});

test('管理员未知斜杠内容回落到普通消息分发，已识别命令仍被处理', async () => {
  const h = await fixture();
  try {
    h.setMode('chat');
    await h.handleIncoming('group', 456, { ...message('/help me'), user_id: 123 }, h.cfg);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /\/help me/);
    const sentBefore = h.calls.sent.length;
    await h.handleIncoming('group', 456, { ...message('/status'), message_id: 101, user_id: 123 }, h.cfg);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.sent.length, sentBefore + 1);
  } finally { await h.close(); }
});
