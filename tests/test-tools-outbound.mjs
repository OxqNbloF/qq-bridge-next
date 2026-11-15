import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { isSendToolName } from '../src/policy/audit.js';
import { createToolSendRoutes } from '../src/features/tools/http-face/send.js';
import { TOOL_ROUTES } from '../src/features/tools/gateway.js';
import { createParticipationV2 } from '../src/features/social-v2/participation.js';
import { assertMemoryWriteAllowed } from '../src/memory/write-guard.js';
import { createConsoleTermsRoutes } from '../src/features/console/routes/terms.js';
import { rememberModelSources } from '../src/memory/model-sources.js';
import { createModeDispatch } from '../src/conversations/mode-dispatch.js';
import { buildEnvelope } from '../src/pipeline/envelope.js';
import { createSendTimeline } from '../src/features/send/timeline.js';
import { createOutbound } from '../src/outbound/router.js';
import { prepareOutboundItems } from '../src/outbound/validation.js';

const enabled = { chat: true, 'closed-agent': true, reserved: true, reserved2: true };
async function fixture(mode, config = {}, globals = {}) {
  const h = await bridgeHarness({ config: { modes: { engine: enabled }, sendDelayMs: 0, socialV2: { send: { maxSendPerMinute: 0, maxSendPerHour: 0 } }, ...config }, globals });
  h.setMode(mode);
  const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
  const token = h.getSocialV2State(key).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, 'x-agent-call': '1', 'x-agent-token': token, ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { h, key, token, call, server, async close() { await new Promise((resolve) => server.close(resolve)); await h.close(); } };
}

for (const mode of Object.keys(enabled)) test(`${mode} 网关共享 read/memory；工具发送遵循模式矩阵`, async () => {
  const f = await fixture(mode);
  try {
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '共享工具记忆' })).status, 200);
    assert.equal((await f.call(`/api/agent/memory?key=${f.key}`)).status, 200);
    const result = await f.call('/api/agent/send-message', { key: f.key, messages: ['工具矩阵回复'] });
    assert.equal(result.status, mode === 'chat' ? 403 : 200, JSON.stringify(result));
    assert.equal(f.h.calls.http.some((call) => /send_(private|group)_msg/.test(call.url)), mode !== 'chat');
    const burst = await f.call('/api/agent/send-burst', { key: f.key, messages: ['一条', '二条'] });
    if (['chat', 'reserved'].includes(mode)) assert.equal(burst.status, 403);
  } finally { await f.close(); }
});

test('网关拒绝跨会话、撤销令牌、错误 caller、管理端点及未知路由', async () => {
  const f = await fixture('reserved2');
  try {
    for (const path of ['/api/agent/recent?key=private:123', '/api/console/scheduler/config', '/api/agent/unknown']) assert.equal((await f.call(path)).status, 403);
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`, null, { 'x-agent-call': 'true' })).status, 403);
    assert.equal((await f.call('/api/agent/memory-append', { key: 'private:123', category: 'activeTopic', content: '不可越权' })).status, 403);
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '不可伪造', token: 'wrong' })).status, 403);
    f.h.retireSession(f.key);
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 403);
  } finally { await f.close(); }
});

test('工具开关、暂停和成员记忆策略在网关生效', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true }, socialV2: { tools: { memory: false } } });
  try {
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    assert.equal((await f.call(`/api/agent/memory?key=${f.key}`)).status, 403);
    f.h.socialV2.paused = true;
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 403);
  } finally { await f.close(); }
});

test('工具结果统一隐藏令牌/路径与默认隐藏的成员身份字段', async () => {
  const f = await fixture('reserved2');
  try {
    f.h.getSocialV2State(f.key).activeTopics = [{ text: `保密 ${f.token} /Users/private/secret.txt`, lastMentionAt: Date.now() }];
    const result = await f.call(`/api/agent/memory?key=${f.key}`);
    assert.equal(result.status, 200);
    assert.ok(!JSON.stringify(result.body).includes(f.token));
    assert.ok(!JSON.stringify(result.body).includes('/Users/private/secret.txt'));
    const members = await f.call(`/api/agent/group-members?key=${f.key}`);
    assert.equal(members.status, 200);
    assert.ok(!JSON.stringify(members.body).includes('userId'));
  } finally { await f.close(); }
});

for (const mode of Object.keys(enabled)) test(`${mode} Outbound 自动/工具发送策略`, async () => {
  const f = await fixture(mode);
  try {
    const auto = f.h.enqueueOutbound(f.key, { text: '自动文本', ai: true, channel: 'auto-text' });
    if (mode === 'reserved2') await assert.rejects(auto, /只允许工具/);
    else await auto;
    const tool = f.h.enqueueOutbound(f.key, { text: '工具文本', ai: true, channel: 'tool', tool: 'sendMessage' });
    if (mode === 'chat') await assert.rejects(tool, /不允许/);
    else await tool;
  } finally { await f.close(); }
});

test('统一限频：失败释放额度，其他群独立发送', async () => {
  const f = await fixture('reserved2', { allow: { groups: ['456', '789'], private: ['123'] }, socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 1 } } });
  try {
    const original = f.h.bot.sendGroupMessage.bind(f.h.bot);
    f.h.bot.sendGroupMessage = async () => { throw new Error('发送失败'); };
    await assert.rejects(f.h.enqueueOutbound(f.key, { text: '失败不占额度', ai: true, channel: 'tool', tool: 'sendMessage' }), /发送失败/);
    f.h.bot.sendGroupMessage = original;
    await f.h.enqueueOutbound(f.key, { text: '成功占额度', ai: true, channel: 'tool', tool: 'sendMessage' });
    await assert.rejects(f.h.enqueueOutbound(f.key, { text: '频率限制', ai: true, channel: 'tool', tool: 'sendMessage' }), /频率超限/);
    await f.h.enqueueOutbound('group:789', { text: '另一群独立', ai: true, channel: 'tool', tool: 'sendMessage' });
    assert.equal(f.h.calls.sent.length, 2);
  } finally { await f.close(); }
});

test('排队期间同 ID 重建也撤销旧发送，且不影响后续项', async () => {
  const f = await fixture('reserved2');
  try {
    await f.h.ensureSession(f.key);
    const old = f.h.state.sessions[f.key];
    const pending = f.h.enqueueOutbound(f.key, { text: '旧发送', ai: true, channel: 'tool', tool: 'sendMessage' });
    f.h.retireSession(f.key, { preserveQueue: true });
    f.h.state.sessions[f.key] = old;
    f.h.state.sessionPolicies[f.key] = f.h.sessionPolicy(f.key);
    await assert.rejects(pending, /发送已取消/);
    await f.h.enqueueOutbound(f.key, { text: '新发送', ai: true, channel: 'tool', tool: 'sendMessage' });
    assert.equal(f.h.calls.sent.length, 1);
  } finally { await f.close(); }
});

test('批次令牌不能拆段绕过；引用和 @ 原样送入既有 OneBot 校验', async () => {
  const f = await fixture('reserved2');
  try {
    await assert.rejects(f.h.sendMessagesV2(f.key, [f.token.slice(0, 8), f.token.slice(8)], [], null), /令牌/);
    await f.h.sendMessagesV2(f.key, ['带引用'], [], '-123', '999');
    const segments = f.h.calls.http.find((call) => call.url.endsWith('/send_group_msg')).body.message;
    assert.equal(segments[0].type, 'reply');
    assert.equal(segments[0].data.id, '-123');
    assert.equal(segments[1].data.qq, '999');
    await assert.rejects(f.h.sendMessagesV2(f.key, ['非法引用'], [], '0'), /非零整数/);
    await assert.rejects(f.h.sendMessagesV2(f.key, ['禁止全体'], [], null, 'all'), /不能为 all/);
  } finally { await f.close(); }
});

test('保留文字发送工具判重，业务模块没有直连发送', () => {
  for (const name of ['send_message', 'send_burst', 'reply']) assert.equal(isSendToolName(`mcp__snowluma__qq_${name}`), true);
  for (const name of ['send_sticker', 'send_voice', 'send_poke']) assert.equal(isSendToolName(`mcp__snowluma__qq_${name}`), false);
  for (const file of ['send/sender', 'send/timeline', 'send/v2', 'sticker/send', 'voice/send', 'console/routes/social', 'tools/http-face/social-v2']) {
    const source = fs.readFileSync(new URL(`../src/features/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /bot\.(?:sendPrivateMessage|sendGroupMessage)|bot\.raw\(['"](?:send_poke|group_poke)|['"]send_(?:private|group)_msg['"]/);
  }
  assert.equal(TOOL_ROUTES['GET /api/console/scheduler/config'], undefined);
});

test('F15 群发送缺来源 fail closed，不把工具参数目标当触发成员；关闭 gate 保持兼容', async () => {
  for (const gateV2 of [true, false]) {
    const f = await fixture('reserved2', { architecture: { gateV2 } });
    try {
      const result = await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool: 'sendGroup', sourceQqs: ['789'], targetUserId: '789' });
      assert.equal(result.status, gateV2 ? 403 : 200, JSON.stringify(result));
      assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
      assert.equal((await f.call(`/api/agent/state?key=${f.key}`)).status, 200);
    } finally { await f.close(); }
  }
});

test('F15 身份目录按目标 context 过滤，不把目标成员当来源或要求 respond/memory', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true }, identity: { exposeQqInPrompt: true } });
  try {
    f.h.bot.request = async () => [
      { user_id: 789, nickname: 'hidden' }, { user_id: 790, nickname: 'visible' }, { nickname: 'unknown' },
    ];
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { context: false } }, 790: { flags: { respond: false, memory: false } },
    } } } })); f.h.loadMemberPolicy();
    const result = await f.call(`/api/agent/group-members?key=${f.key}`);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body.members.map(member => member.nickname), ['visible']);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.returned, 1);
    assert.deepEqual(f.h.getSocialV2State(f.key).modelSourceQqs, [], '目录目标不是触发来源');
    f.h.getSocialV2State(f.key).recentMessages.push({ userId: '791', text: '真实来源' });
    assert.equal((await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool: 'sendGroup', targetUserId: '790' })).status, 200);
  } finally { await f.close(); }
});

test('F15 异步成功响应复查原请求来源，即使当前窗口/账本已被替换', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true }, socialV2: { tools: { setStickerRemark: true } } });
  let release;
  try {
    const st = f.h.getSocialV2State(f.key); st.modelSourceQqs = ['789'];
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const original = f.h.bot.request.bind(f.h.bot);
    f.h.bot.request = async (action, params) => {
      if (action !== 'modify_custom_face') return original(action, params);
      entered(); await blocked; return { status: 'ok', retcode: 0 };
    };
    const pending = f.call('/api/agent/sticker-remark', { key: f.key, stickerId: 'fixture-sticker', remark: '备注' });
    await Promise.race([started, pending.then(result => { throw new Error(`route did not reach async operation: ${JSON.stringify(result)}`); })]);
    st.modelSourceQqs = ['790'];
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { memory: false } },
    } } } })); f.h.loadMemberPolicy();
    release();
    const result = await pending;
    assert.equal(result.status, 403, JSON.stringify(result));
  } finally { release?.(); await f.close(); }
});

for (const [name, flags, sendAllowed, deriveAllowed] of [
  ['all', {}, true, true],
  ['memory=false', { memory: false }, true, false],
  ['respond=false', { respond: false }, false, true],
  ['converse=false', { converse: false }, false, true],
  ['context=false', { context: false }, false, false],
]) test(`F15 四开关正交矩阵 ${name}：普通读取/回合与表情备注、记忆、发送分开`, async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages.push({ userId: '789', messageId: 'f15-source', text: '来源正文', time: Date.now() });
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: { 789: { flags } } } } })); f.h.loadMemberPolicy();
    const recent = await f.call(`/api/agent/recent?key=${f.key}`);
    assert.equal(recent.status, 200);
    assert.equal(JSON.stringify(recent.body).includes('来源正文'), flags.context !== false);
    assert.equal((await f.call(`/api/agent/state?key=${f.key}`)).status, 200);
    const wake = await f.call('/api/agent/wake-config', { key: f.key, config: { mode: 'active' }, throughSeq: 0 });
    assert.equal(wake.status, 200, JSON.stringify(wake));
    assert.equal((await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool: 'sendGroup' })).status, sendAllowed ? 200 : 403);
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '派生记忆' })).status, deriveAllowed ? 200 : 403);
    assert.equal((await f.call(`/api/agent/sticker-list?key=${f.key}`)).status, 200);
    const note = await f.call('/api/agent/sticker-note', { key: f.key, stickerId: 'fixture-sticker', note: '派生表情备注' });
    assert.equal(note.status, deriveAllowed ? 200 : 403, JSON.stringify(note));
    const prompt = await f.call(`/api/agent/prompt?key=${f.key}`);
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.enabledTools.includes('qq_send_group_message'), sendAllowed);
    assert.equal(prompt.body.enabledTools.includes('qq_sticker_note'), deriveAllowed);
  } finally { await f.close(); }
});

test('F15 全部派生/发送路由显式要求来源；session/content 能力无来源仍可读取', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true }, socialV2: { tools: { setStickerRemark: true, sendVoice: true }, voice: { enabled: true } } });
  try {
    for (const [route, rule] of Object.entries(TOOL_ROUTES)) {
      assert.ok(['session', 'content', 'roster', 'memoryRead', 'derive', 'respond'].includes(rule[2]), route);
      if (!['derive', 'respond'].includes(rule[2]) || route.endsWith('/send/private')) continue;
      const body = { key: f.key, token: f.token, groupId: 456, tool: 'sendGroup', stickerId: 'fixture-sticker', category: 'activeTopic', content: '禁止缺来源', messages: ['拒绝'], message: '拒绝' };
      const result = await f.call(route.slice(5), body);
      assert.equal(result.status, 403, `${route}: ${JSON.stringify(result)}`);
      assert.match(result.body.error, /source-unknown/, route);
    }
    for (const route of ['state', 'my-recent', 'active-members', 'sticker-list', 'voices']) {
      assert.equal((await f.call(`/api/agent/${route}?key=${f.key}`)).status, 200, route);
    }
    const prompt = await f.call(`/api/agent/prompt?key=${f.key}`);
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.enabledTools.some(tool => tool.includes('qq_send_voice')), false, '共享 flag 不得公告未获来源授权的语音发送');
    for (const path of ['/api/console/session/reset', '/api/agent/session/reset']) {
      assert.equal((await f.call(path, { key: f.key, scope: 'privacy-context', confirm: true })).status, 403);
    }
  } finally { await f.close(); }
});

test('F15 窗口内 quoted/sourceQqs、模型账本与活跃 timer 来源均不能丢失或降为任意成员', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    const st = f.h.getSocialV2State(f.key);
    const originalActive = f.h.turnEngine.activeRequest;
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: { 790: { flags: { memory: false, respond: false } } } } } })); f.h.loadMemberPolicy();
    for (const provenance of ['quote', 'sourceQqs', 'ledger', 'timer', 'proactive', 'incomplete', 'malformed']) {
      st.recentMessages = [{ userId: '789', text: '来源' }]; st.unread = []; st.modelSourceQqs = []; st.modelSourcesIncomplete = false;
      f.h.turnEngine.activeRequest = () => undefined;
      if (provenance === 'quote') st.recentMessages[0].quote = { senderQq: '790', text: '引用' };
      if (provenance === 'sourceQqs') st.recentMessages[0].sourceQqs = ['789', '790'];
      if (provenance === 'ledger') st.modelSourceQqs = ['790'];
      if (['timer', 'proactive'].includes(provenance)) f.h.turnEngine.activeRequest = () => ({ trigger: { kind: provenance }, payload: { sourceQqs: ['790'] } });
      if (provenance === 'incomplete') st.modelSourcesIncomplete = true;
      if (provenance === 'malformed') st.modelSourceQqs = ['not-a-qq'];
      for (const [path, body] of [
        ['check-send', { tool: 'sendGroup', token: f.token }],
        ['sticker-note', { stickerId: 'fixture-sticker', note: '拒绝' }],
      ]) assert.equal((await f.call(`/api/agent/${path}`, { key: f.key, ...body })).status, 403, `${provenance}/${path}`);
    }
    f.h.turnEngine.activeRequest = originalActive;
  } finally { await f.close(); }
});

for (const engine of [false, true]) for (const mode of Object.keys(enabled)) test(`F15 ${mode} gateV2 开启、模式引擎 ${engine} 保持模式/token/status 契约`, async () => {
  const f = await fixture(mode, { architecture: { gateV2: true }, modes: { engine: engine ? { [mode]: true } : {} } });
  try {
    if (f.key.startsWith('group:')) f.h.getSocialV2State(f.key).recentMessages.push({ userId: '789', text: '已知来源' });
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '有来源' })).status, 200);
    assert.equal((await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool: mode === 'closed-agent' ? 'sendPrivate' : 'sendGroup' })).status, mode === 'chat' ? 403 : 200);
    const status = await fetch(`http://127.0.0.1:${f.server.address().port}/api/agent/status`, { headers: { 'x-console-token': f.h.cfg.consoleToken, 'x-agent-call': '1' } });
    assert.equal(status.status, 200);
    assert.equal((await f.call('/api/agent/status', null, { 'x-agent-token': 'invalid' })).status, 403);
  } finally { await f.close(); }
});

test('私聊 memory=false 阻止记忆工具而不阻止普通读取', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true }, allow: { groups: ['456'], private: ['789'] } });
  try {
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, private: { 789: { respond: true, converse: true, context: true, memory: false } } }));
    f.h.loadMemberPolicy();
    const headers = { 'x-agent-token': f.h.getSocialV2State('private:789').agentToken };
    assert.equal((await f.call('/api/agent/recent?key=private:789', null, headers)).status, 200);
    assert.equal((await f.call('/api/agent/memory?key=private:789', null, headers)).status, 403);
  } finally { await f.close(); }
});

test('群记忆写入复查来源成员，不能伪造来源绕过；删除和普通读取不受影响', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages.push({ userId: '789', messageId: 'blocked-source', text: '不可记忆', time: Date.now() });
    f.h.memoryAPI.append(f.key, 'activeTopic', '先前允许');
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { respond: true, converse: true, context: true, memory: false } },
    } } } }));
    f.h.loadMemberPolicy();
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    for (const category of ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias']) {
      const extra = { target: '789', sourceMessageIds: ['fabricated'] };
      assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category, content: '禁止写入', extra })).status, 403);
      assert.throws(() => f.h.memoryAPI.append(f.key, category, '禁止直接写入', extra), /成员策略/);
    }
    assert.throws(() => f.h.appendMemoryV2(st, 'activeTopic', '禁止底层写入', {}, f.key), /成员策略/);
    assert.equal((await f.call('/api/agent/memory-update', { key: f.key, category: 'activeTopic', oldContent: '先前允许', newContent: '禁止修改' })).status, 403);
    assert.equal(st.activeTopics[0].text, '先前允许');
    assert.equal((await f.call('/api/agent/memory-remove', { key: f.key, category: 'activeTopic', content: '先前允许' })).status, 200);
    assert.equal(st.activeTopics.length, 0);
    st.recentMessages = [];
    assert.throws(() => f.h.appendMemoryV2(st, 'memberImpression', '禁止目标印象', { target: '789' }, f.key), /成员策略/);
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '窗口清空不能遗忘模型历史来源' })).status, 403);
  } finally { await f.close(); }
});

test('模型工具读过的来源在窗口淘汰、跨回合与重启后仍约束派生写入', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  let restarted;
  try {
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages.push({ userId: '789', messageId: 'exposed-source', text: '曾给模型看过', time: Date.now() });
    assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    st.recentMessages = [];
    st.unread = [];
    const policy = { schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { respond: true, converse: true, context: true, memory: false } },
    } } } };
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify(policy));
    f.h.loadMemberPolicy();
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'term', content: '不能遗忘来源', extra: { meaning: '仍受限制' } })).status, 403);
    f.h.retireSession(f.key, { preserveQueue: true });
    assert.throws(() => f.h.memoryAPI.append(f.key, 'activeTopic', '保留队列不能清掉预构建来源'), /成员策略/);
    f.h.saveSocialV2State();
    restarted = await bridgeHarness({ config: { architecture: { gateV2: true } }, files: {
      'state/social-v2.json': fs.readFileSync(`${f.h.temp}/state/social-v2.json`, 'utf8'),
      'state/member-policy.json': policy,
    } });
    assert.throws(() => restarted.memoryAPI.append(f.key, 'activeTopic', '重启不能解除限制'), /成员策略/);
    f.h.retireSession(f.key);
    assert.doesNotThrow(() => f.h.memoryAPI.append(f.key, 'activeTopic', '撤销旧上下文后可重新开始'));
  } finally { await restarted?.close(); await f.close(); }
});

test('普通投递累计当前来源，清空窗口后仍受成员策略约束', async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', '当前输入', { sourceQqs: ['789'] });
    assert.doesNotThrow(() => h.memoryAPI.append('group:456', 'activeTopic', '新会话允许写入'));
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { 'group:456': { mode: 'all', rules: {
      789: { flags: { memory: false } },
    } } } }));
    h.loadMemberPolicy();
    assert.throws(() => h.memoryAPI.append('group:456', 'activeTopic', '跨回合不能遗忘'), /成员策略/);
  } finally { await h.close(); }
});

test('R01-QUOTE envelope 对外携带正文来源，不把 @ 或空引用当正文', async () => {
  const event = { group_id: 456, user_id: 790, message: [
    { type: 'reply', data: { id: '9000' } }, { type: 'at', data: { qq: '791' } },
    { type: 'text', data: { text: '当前消息' } },
  ] };
  for (const text of ['原作者正文', '']) {
    const envelope = await buildEnvelope('group', event, { resolveReply: async () => ({ userId: 789, text }) });
    assert.deepEqual(envelope.sourceQqs, text ? ['790', '789'] : ['790']);
  }
});

test('R01-QUOTE chat 引用窗口外正文后清窗重启，HTTP 派生写入仍拒绝原作者', async () => {
  const f = await fixture('chat', { architecture: { gateV2: true } });
  let restarted, server;
  try {
    f.h.bot.getMessage = async messageId => ({ message_id: messageId, group_id: 456,
      sender: { user_id: 789, nickname: '原作者' }, message: [{ type: 'text', data: { text: '窗口外引用正文' } }] });
    f.h.setReady(false);
    await f.h.acceptPipelineMessage('group', { group_id: 456, user_id: 790, self_id: 999,
      message_id: 9101, sender: { nickname: '转述者' }, message: [
        { type: 'reply', data: { id: '9100' } }, { type: 'at', data: { qq: '791' } },
        { type: 'text', data: { text: '请看这段引用' } },
      ] }, f.h.cfg);
    const queued = f.h.turnEngine.snapshot().conversations.find(conv => conv.conv === f.key).queue[0].request;
    assert.deepEqual(queued.payload.sourceQqs, ['790', '789'], '引用正文的原作者必须跟随排队负载');
    f.h.setReady(true); await f.h.turnEngine.replay();
    for (let i = 0; i < 100 && !f.h.calls.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.h.calls.prompts.some(call => JSON.stringify(call).includes('窗口外引用正文')), '真实管线将引用正文投递给假 DSH');
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages = []; st.unread = [];
    const policy = { schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { memory: false } }, 791: { flags: { memory: false } },
    } } } };
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify(policy)); f.h.loadMemberPolicy();
    f.h.saveSocialV2State();
    restarted = await bridgeHarness({ config: { architecture: { gateV2: true }, modes: { engine: enabled } },
      savedState: JSON.parse(fs.readFileSync(`${f.h.temp}/state/sessions.json`, 'utf8')),
      files: { 'state/social-v2.json': fs.readFileSync(`${f.h.temp}/state/social-v2.json`, 'utf8'), 'state/member-policy.json': policy },
    });
    restarted.setMode('chat');
    server = restarted.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/memory-append`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': restarted.cfg.consoleToken,
        'x-agent-call': '1', 'x-agent-token': restarted.getSocialV2State(f.key).agentToken },
      body: JSON.stringify({ key: f.key, category: 'activeTopic', content: '不得从已读引用派生记忆' }),
    });
    assert.equal(response.status, 403, JSON.stringify(await response.json()));
    assert.deepEqual(st.modelSourceQqs, ['789', '790'], '引用作者是正文来源，@目标不是');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await restarted?.close(); await f.close();
  }
});

test('R01-QUOTE reserved2 入站来源随消息落盘，HTTP 读取引用后累计原作者而非 @', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    const policy = { schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      790: { flags: { respond: false } },
    } } } };
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify(policy)); f.h.loadMemberPolicy();
    f.h.bot.getMessage = async messageId => ({ message_id: messageId, group_id: 456,
      sender: { user_id: 789, nickname: '原作者' }, message: [{ type: 'text', data: { text: '二代引用正文' } }] });
    await f.h.acceptPipelineMessage('group', { group_id: 456, user_id: 790, self_id: 999,
      message_id: 9201, sender: { nickname: '转述者' }, message: [
        { type: 'reply', data: { id: '9200' } }, { type: 'at', data: { qq: '791' } },
        { type: 'text', data: { text: '仅存入历史再读取' } },
      ] }, f.h.cfg);
    const recent = await f.call(`/api/agent/recent?key=${f.key}`);
    assert.equal(recent.status, 200);
    assert.ok(JSON.stringify(recent.body).includes('二代引用正文'));
    const st = f.h.getSocialV2State(f.key);
    const message = st.recentMessages.at(-1);
    st.recentMessages = []; st.unread = [];
    policy.groups[f.key].rules[789] = { flags: { memory: false } };
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify(policy)); f.h.loadMemberPolicy();
    const write = await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '不得忘记二代引用来源' });
    assert.equal(write.status, 403, JSON.stringify(write));
    assert.deepEqual(message.sourceQqs, ['790', '789']);
    assert.deepEqual(st.modelSourceQqs, ['789', '790']);
    st.recentMessages = [message]; f.h.saveSocialV2State();
    const saved = JSON.parse(fs.readFileSync(`${f.h.temp}/state/social-v2.json`, 'utf8'));
    assert.deepEqual(saved.conversations[f.key].recentMessages[0].sourceQqs, ['790', '789']);
  } finally { await f.close(); }
});

test('R01-QUOTE helper 读取 quote.senderQq 与每条 sourceQqs，不读取 @/mentions', () => {
  const st = { modelSourceQqs: [] };
  rememberModelSources({ cfg: {}, getSocialV2State: () => st, saveSocialV2State: () => true }, 'group:456', [
    { userId: '790', quote: { senderQq: 789, text: '引用正文' }, mentions: [{ qq: '791', by: 'at' }] },
    { userId: '792', sourceQqs: ['792', '793'] },
  ]);
  assert.deepEqual(st.modelSourceQqs, ['789', '790', '792', '793']);
});

test('R01-QUOTE 一代 dispatch 向 recent/summary 传递完整正文来源', async () => {
  const recent = [], summaries = [];
  const { dispatchModeMessage } = createModeDispatch({
    modeForKey: () => 'reserved', renderIdentityRoster: () => '', currentRoleHint: () => '',
    sanitizeUntrustedText: String, mediaHintFor: () => '', appendActivity() {}, log() {},
    isSocialEnabled: () => true, socialState: () => ({ phase: 'exiting' }),
    appendRecentMessage: (...args) => recent.push(args), appendSummary: (...args) => summaries.push(args),
  });
  await dispatchModeMessage({ envelope: { sender: { qq: 790 }, quote: { senderQq: 789, text: '原文' }, mentions: [{ qq: '791', by: 'at' }] },
    cfg: {}, key: 'group:456', kind: 'group', id: 456, flags: { respond: true, context: true }, event: { user_id: 790 },
    senderName: '转述者', textContent: '原文及当前消息', plainContent: '当前消息', mediaList: [], messageRef: '9301' });
  assert.deepEqual(recent[0].at(-1), { userId: 790, respondAllowed: true, sourceQqs: ['790', '789'] });
  assert.deepEqual(summaries[0].at(-1), { userId: 790, sourceQqs: ['790', '789'] });
});

test('模型来源落盘失败必须重试保存，不能因内存已登记而放行', () => {
  const st = { modelSourceQqs: [] };
  let saves = 0;
  const b = { cfg: { architecture: { gateV2: true } }, getSocialV2State: () => st, saveSocialV2State: () => { saves++; return false; } };
  for (let i = 0; i < 2; i++) assert.throws(() => rememberModelSources(b, 'group:456', [{ userId: '789' }]), /来源保存失败/);
  assert.equal(saves, 2);
});

test('恢复缺来源账本的旧 DSH 上下文时拒绝派生写入，退役后解除', async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let restarted;
  try {
    h.setMode('chat');
    await h.ensureSession('group:456');
    h.saveSocialV2State();
    const saved = JSON.parse(fs.readFileSync(`${h.temp}/state/social-v2.json`, 'utf8'));
    delete saved.conversations['group:456'].modelSourceQqs;
    restarted = await bridgeHarness({ config: { architecture: { gateV2: true } },
      savedState: JSON.parse(fs.readFileSync(`${h.temp}/state/sessions.json`, 'utf8')),
      files: { 'state/social-v2.json': saved },
    });
    assert.throws(() => restarted.memoryAPI.append('group:456', 'activeTopic', '不能猜历史来源'), /model-sources-incomplete/);
    restarted.retireSession('group:456');
    assert.doesNotThrow(() => restarted.memoryAPI.append('group:456', 'activeTopic', '旧会话已撤销'));
  } finally { await restarted?.close(); await h.close(); }
});

test('底层印象写入仅接受 QQ 或唯一身份别名，历史未解析项只读', async () => {
  const f = await fixture('reserved2');
  try {
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages.push({ userId: '789' });
    const { appendMemoryV2 } = createParticipationV2({
      cfg: f.h.cfg, socialV2: { conversations: new Map([[f.key, st]]) },
      resolveIdentityAlias: ({ text }) => text === '唯一称呼' ? { qq: '789' } : { ambiguous: true, qqs: ['789', '790'] },
      redactKnownTokensOnly: String, saveSocialV2State() {},
    });
    appendMemoryV2(st, 'memberImpression', '友善', { target: '唯一称呼' }, f.key);
    appendMemoryV2(st, 'memberImpression', '健谈', { target: '789' }, f.key);
    for (const target of ['同名', '__proto__']) {
      assert.throws(() => appendMemoryV2(st, 'memberImpression', '不应写入', { target }, f.key), /无法唯一解析/);
    }
    assert.throws(() => appendMemoryV2(st, 'memberImpression', '不应写入', { target: 'legacy:唯一称呼' }, f.key), /历史印象只读/);
    assert.deepEqual(Object.keys(st.memberImpressions), ['789']);
    assert.deepEqual(st.memberImpressions['789'].traits, ['友善', '健谈']);
  } finally { await f.close(); }
});

test('底层记忆写入显式传递会话，不扫描会话表；未知会话不能跳过灰度守卫', () => {
  const st = { recentMessages: [], unread: [], activeTopics: [] };
  const conversations = { get: () => st, [Symbol.iterator]() { throw new Error('禁止扫描会话表'); } };
  const { appendMemoryV2 } = createParticipationV2({
    cfg: { architecture: { gateV2: true } }, socialV2: { conversations },
    gateDecide: () => ({ allowed: true, flags: { memory: true } }),
    redactKnownTokensOnly: String, saveSocialV2State() {},
  });
  assert.doesNotThrow(() => appendMemoryV2(st, 'activeTopic', '直接会话参数', {}, 'group:456'));
  assert.equal(st.activeTopics[0].text, '直接会话参数');
  assert.throws(() => appendMemoryV2(st, 'activeTopic', '未知会话'), /无法确认记忆所属会话/);
});

test('agent 非法印象目标返回 400，不被预先记忆守卫降为 403', async () => {
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    f.h.getSocialV2State(f.key).recentMessages.push({ userId: '789' });
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [f.key]: { mode: 'all', rules: {
      789: { flags: { memory: false } },
    } } } }));
    f.h.loadMemberPolicy();
    for (const target of ['__proto__', 'constructor', 'prototype']) {
      const append = await f.call('/api/agent/memory-append', { key: f.key, category: 'memberImpression', content: '非法目标', extra: { target } });
      const update = await f.call('/api/agent/memory-update', { key: f.key, category: 'memberImpression', target, newContent: '非法目标' });
      assert.equal(append.status, 400);
      assert.equal(update.status, 400);
      assert.equal(append.body.error, '非法的群友名字');
    }
  } finally { await f.close(); }
});

test('群印象拒绝无成员证据的任意 QQ，身份关闭时仍可用已观察 QQ', () => {
  const key = 'group:456';
  const st = { recentMessages: [{ userId: '789' }], unread: [], memberImpressions: {} };
  const { appendMemoryV2 } = createParticipationV2({
    cfg: { identity: { enabled: false } }, redactKnownTokensOnly: String, saveSocialV2State() {},
  });
  assert.throws(() => appendMemoryV2(st, 'memberImpression', '幽灵印象', { target: '999999999' }, key), /未观察到该群成员/);
  assert.doesNotThrow(() => appendMemoryV2(st, 'memberImpression', '已观察成员', { target: '789' }, key));
  assert.deepEqual(Object.keys(st.memberImpressions), ['789']);
  assert.throws(() => appendMemoryV2(st, 'memberImpression', '不能按名字猜测', { target: '小王' }, key), /无法唯一解析/);
});

test('控制台会话词汇不绕过成员记忆策略，全局人工词汇不受会话来源限制', async () => {
  const appended = [];
  const route = createConsoleTermsRoutes({
    cfg: { architecture: { gateV2: true } }, termsWritable: true,
    socialV2: { conversations: new Map([['group:456', { recentMessages: [{ userId: '789' }] }]]) },
    gateDecide: () => ({ allowed: true, flags: { memory: false } }),
    terms: { append: (...args) => { appended.push(args); return {}; } },
  });
  const responses = [];
  for (const key of ['group:0456', 'global']) await route({
    req: { method: 'POST' }, url: new URL('http://localhost/api/console/memory/terms'),
    readBody: async () => ({ key, content: '人工词汇' }),
    sendJson: (body, status = 200) => responses.push({ body, status }),
  });
  assert.deepEqual(responses.map(result => result.status), [403, 200]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], 'global');
  assert.equal(appended[0][2].source, 'manual');
});

test('记忆守卫复查活跃回合来源，不依赖未读保留；关闭灰度保留旧行为', () => {
  const seen = [];
  const b = {
    cfg: { architecture: { gateV2: true } },
    turnEngine: { activeRequest: () => ({ payload: { sourceQqs: [789] } }) },
    gateDecide: input => { seen.push(input); return { allowed: true, flags: { memory: false } }; },
  };
  assert.throws(() => assertMemoryWriteAllowed(b, 'group:456'), /成员策略/);
  assert.deepEqual(seen, [{ kind: 'group', id: 456, qq: '789' }]);
  b.cfg.architecture.gateV2 = false;
  assert.doesNotThrow(() => assertMemoryWriteAllowed(b, 'group:456'));
  assert.equal(seen.length, 1);
});

test('媒体与文本及控制台测试发送共用 FIFO，拍一拍也进同一队列', async () => {
  const f = await fixture('reserved2');
  try {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const order = [];
    const original = f.h.bot.sendGroupMessage.bind(f.h.bot);
    f.h.bot.sendGroupMessage = async (...args) => { order.push('ws'); await blocked; return original(...args); };
    f.h.bot.raw = async (action) => { assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1); order.push(action); return {}; };
    const text = f.h.enqueueOutbound(f.key, { text: '先发文字', channel: 'console' });
    const media = f.h.enqueueOutbound(f.key, { segments: [{ type: 'image', data: { file: 'base64://Zg==' } }], archiveText: '[表情]', ai: true, channel: 'tool', tool: 'sendMessage', group: 'sticker' });
    const poke = f.h.enqueueOutbound(f.key, { action: 'group_poke', params: { group_id: 456, user_id: 111 }, archiveText: '[拍一拍]', ai: true, channel: 'tool', tool: 'sendMessage' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['ws']);
    assert.equal(f.h.calls.http.length, 0);
    release();
    await Promise.all([text, media, poke]);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1);
    assert.deepEqual(order, ['ws', 'group_poke']);
    const result = await f.call('/api/console/test-send', { kind: 'group', id: 456, message: '控制台测试' }, { 'x-agent-token': '', 'x-agent-call': '1' });
    assert.equal(result.status, 403, 'agent 不能伪装管理端');
    const consoleResponse = await fetch(`http://127.0.0.1:${f.server.address().port}/api/console/test-send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': f.h.cfg.consoleToken },
      body: JSON.stringify({ kind: 'group', id: 456, message: '控制台测试' }),
    });
    assert.equal(consoleResponse.status, 200);
    assert.equal(f.h.calls.sent.length, 2);
  } finally { await f.close(); }
});

test('reserved2 的时间线输出也不能绕过仅工具发送', async () => {
  const f = await fixture('reserved2');
  try {
    await assert.rejects(f.h.enqueueOutbound(f.key, { text: '不能自动发送', ai: true, channel: 'timeline' }), /只允许工具/);
    assert.equal(f.h.calls.sent.length, 0);
  } finally { await f.close(); }
});

test('二代暂停/关闭不影响一代受限发送，回合控制单独限制', async () => {
  const f = await fixture('reserved', { socialV2: { enabled: false, wait: { minMs: 100, maxMs: 100 } } });
  try {
    f.h.socialV2.paused = true;
    const sent = await f.call('/api/agent/send/group', { groupId: 456, message: '一代工具仍可用', token: f.token });
    assert.equal(sent.status, 200, JSON.stringify(sent));
    const waited = await f.call('/api/agent/wait', { key: f.key, timeoutMs: 100 });
    assert.equal(waited.status, 403, JSON.stringify(waited));
  } finally { await f.close(); }
});

for (const mode of Object.keys(enabled)) test(`${mode} 通用工具令牌在排队重建后刷新`, async () => {
  const f = await fixture(mode);
  try {
    f.h.setReady(false);
    await f.h.deliverPrompt(f.key, `【会话令牌】${f.token}（工具）\n模式工具提示`);
    f.h.retireSession(f.key, { preserveQueue: true });
    const current = f.h.getSocialV2State(f.key).agentToken;
    assert.notEqual(current, f.token);
    f.h.setReady(true); await f.h.turnEngine.replay();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const text = f.h.calls.prompts[0].content[0].text;
    assert.ok(text.includes(`【会话令牌】${current}`));
    assert.ok(!text.includes(f.token));
  } finally { await f.close(); }
});

test('自动发送用尽统一额度后工具返回 429，撤销其旧层预占', async () => {
  const f = await fixture('reserved', { socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 1 } } });
  try {
    await f.h.enqueueOutbound(f.key, { text: '占用统一额度', ai: true, channel: 'timeline' });
    const st = f.h.getSocialV2State(f.key);
    const before = st.sendTimes.length;
    const result = await f.call('/api/agent/send-message', { key: f.key, messages: ['工具也受统一限频'] });
    assert.equal(result.status, 429, JSON.stringify(result));
    assert.equal(st.sendTimes.length, before);
    assert.equal(f.h.calls.http.some((call) => call.url.endsWith('/send_group_msg')), false);
  } finally { await f.close(); }
});

for (const kind of ['group', 'private', 'reply']) test(`${kind} decoy key 不能覆盖实际发送目标`, async () => {
  const f = await fixture('reserved', { modes: { engine: { reserved: true } }, allow: { groups: ['456', '789'], private: ['123', '789'] } });
  try {
    const body = { message: '不可跨会话', ...(kind === 'private' ? { userId: '789' } : { groupId: '789' }), ...(kind === 'reply' ? { replyToMessageId: '123' } : {}) };
    for (const decoy of ['query', 'body', 'target']) {
      const query = decoy === 'query' ? '?key=group:456' : '';
      const extra = decoy === 'body' ? { key: f.key } : decoy === 'target' ? { target: f.key } : {};
      assert.equal((await f.call(`/api/agent/send/${kind}${query}`, { ...body, ...extra })).status, 403);
    }
    assert.equal((await f.call('/api/agent/send/group?key=group:456&key=group:789', { groupId: '456', message: '重复 key' })).status, 403);
    assert.equal((await f.call('/api/agent/send/group?key=group:789', { key: f.key, groupId: '456', message: '实际目标正确但 decoy 不同' })).status, 403);
    assert.equal(f.h.calls.http.some((call) => /send_(group|private)_msg/.test(call.url)), false);
    if (kind === 'group') assert.equal((await f.call('/api/agent/send/group', { groupId: ' 456 ', message: '合法实际目标' })).status, 200);
  } finally { await f.close(); }
});

test('发送路由独立验证实际目标的 header token，不依赖网关或 body.token', async () => {
  for (const kind of ['group', 'private', 'reply']) {
    const checked = [], responses = [];
    const routes = createToolSendRoutes({
      modeForKey: () => 'reserved', socialV2: { paused: false },
      agentTokenOk: (key, token) => { checked.push({ key, token }); return false; },
    });
    await routes({ toolPolicy: true, req: { method: 'POST', headers: { 'x-agent-token': 'group-456-token' } },
      url: new URL(`http://localhost/api/agent/send/${kind}`),
      readBody: async () => ({ key: 'group:456', groupId: '789', userId: '789', message: '跨会话', replyToMessageId: '123' }),
      sendJson: (body, status) => responses.push({ body, status }),
    });
    assert.equal(responses[0].status, 403);
    assert.deepEqual(checked, [{ key: `${kind === 'private' ? 'private' : 'group'}:789`, token: 'group-456-token' }]);
  }
});

for (const on of [false, true]) test(`closed-agent 引擎${on ? '开启' : '关闭'}的 tokenless 拒绝契约`, async () => {
  const f = await fixture('closed-agent', { modes: { engine: on ? { 'closed-agent': true } : {} } });
  try {
    const response = await fetch(`http://127.0.0.1:${f.server.address().port}/api/agent/send/private`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': f.h.cfg.consoleToken, 'x-agent-call': '1' },
      body: JSON.stringify({ userId: '123', message: '无令牌发送' }),
    });
    assert.equal(response.status, 403);
    const valid = await f.call('/api/agent/send/private', { userId: '123', message: '只传 header token' });
    assert.equal(valid.status, 200, JSON.stringify(valid));
    const unrelated = f.h.getSocialV2State('group:456').agentToken;
    assert.equal((await f.call('/api/agent/send/private', { userId: '123', message: '不能借其他会话令牌' }, { 'x-agent-token': unrelated })).status, 403);
    await f.h.deliverPrompt(f.key, '检查工具契约');
    assert.match(f.h.calls.prompts[0].content[0].text, /调用 QQ 工具.*调用新 Agent API 时必须携带/);
    const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /closed-agent 模式不需要/);
  } finally { await f.close(); }
});

for (const mode of Object.keys(enabled)) test(`${mode} 单模式开启的 HTTP 鉴权矩阵`, async () => {
  const f = await fixture(mode, { modes: { engine: { [mode]: true } } });
  try {
    const path = `/api/agent/recent?key=${f.key}`;
    assert.equal((await f.call(path)).status, 200);
    assert.equal((await f.call(path, null, { 'x-agent-token': 'wrong' })).status, 403);
    assert.equal((await f.call(path, null, { 'x-agent-token': '' })).status, 403);
    const missing = await fetch(`http://127.0.0.1:${f.server.address().port}${path}`, { headers: { 'x-console-token': f.h.cfg.consoleToken, 'x-agent-call': '1' } });
    assert.equal(missing.status, 403);
    assert.equal((await f.call(path, null, { 'x-agent-call': 'true' })).status, 403);
    assert.equal((await f.call(path, null, { 'x-console-token': 'wrong' })).status, 401);
    assert.equal((await f.call(path, null, { origin: 'https://untrusted.invalid' })).status, 200, '只读 GET 不使用写入 CSRF 规则');
    assert.equal((await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '测试' }, { origin: 'https://untrusted.invalid' })).status, 403);
    const cross = mode === 'closed-agent' ? 'group:456' : 'private:123';
    assert.equal((await f.call(`/api/agent/recent?key=${cross}`)).status, 403);
    assert.equal((await f.call('/api/console/scheduler/config')).status, 403);
  } finally { await f.close(); }
});

test('Outbound 不接受缺工具标识，实际 poke 和声明 burst 都执行 deny', async () => {
  const f = await fixture('reserved', { modes: { engine: { reserved: true } } });
  try {
    for (const intent of [
      { text: '无标识', channel: 'tool', group: 'send' },
      { text: '批量', channel: 'tool', tool: 'sendBurst' },
      { action: 'group_poke', params: { group_id: 456, user_id: 111 }, channel: 'tool', tool: 'sendMessage' },
    ]) await assert.rejects(f.h.enqueueOutbound(f.key, { ai: true, ...intent }), /不允许/);
    assert.equal(f.h.calls.sent.length, 0);
  } finally { await f.close(); }
});

test('退役清除统一额度；成功清失败标记；批次部分失败仍保留失败标记', async () => {
  const f = await fixture('reserved', { socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 1 } } });
  try {
    await f.h.enqueueOutbound(f.key, { text: '旧额度', ai: true, channel: 'timeline' });
    f.h.retireSession(f.key, { preserveQueue: true });
    f.h.bot.sendGroupMessage = async () => { throw new Error('失败'); };
    await assert.rejects(f.h.enqueueOutbound(f.key, { text: '失败', ai: true, channel: 'timeline' }), /失败/);
    f.h.bot.sendGroupMessage = async () => ({ message_id: 7 });
    await f.h.enqueueOutbound(f.key, { text: '新额度', ai: true, channel: 'timeline' });
    assert.equal(f.h.lastSendSucceeded(f.key), true);
    f.h.retireSession(f.key, { preserveQueue: true });
    let n = 0;
    f.h.bot.sendGroupMessage = async () => { if (++n === 1) throw new Error('首条失败'); return {}; };
    await f.h.sendBurstToQQ(f.key, ['失败', '成功'], 0, 0);
    assert.equal(f.h.lastSendSucceeded(f.key), false);
    f.h.retireSession(f.key, { preserveQueue: true });
    f.h.cfg.socialV2.send = { maxSendPerMinute: 10, maxSendPerHour: 100 };
    f.h.cfg.social.maxReplyChars = 10;
    const burstSent = [];
    f.h.bot.sendGroupMessage = async (_gid, text) => {
      burstSent.push(text);
      f.h.cfg.social.maxReplyChars = 2;
      return { message_id: burstSent.length };
    };
    const burstRes = await f.h.sendBurstToQQ(f.key, ['短', '这段话在收紧后超长'], 0, 0);
    assert.equal(burstSent.length, 1);
    assert.deepEqual(burstRes, ['短']);
    assert.equal(f.h.lastSendSucceeded(f.key), false);
  } finally { await f.close(); }
});

test('read 与回合控制分离，chat/reserved 不能修改二代回合', async () => {
  for (const mode of ['chat', 'reserved']) {
    const f = await fixture(mode, { modes: { engine: { [mode]: true } } });
    try {
      for (const path of ['mark-read', 'wake-config', 'wait']) assert.equal((await f.call(`/api/agent/${path}`, { key: f.key })).status, 403);
      assert.equal((await f.call(`/api/agent/recent?key=${f.key}`)).status, 200);
    } finally { await f.close(); }
  }
});

test('check-send 按实际发送工具开关判定，不继承 sendMessage 开关', async () => {
  const f = await fixture('reserved', { modes: { engine: { reserved: true } }, socialV2: { tools: { sendMessage: false, sendGroup: true, sendPrivate: false, reply: false } } });
  try {
    assert.equal((await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool: 'sendGroup' })).status, 200);
    for (const tool of ['sendPrivate', 'reply', 'toString']) assert.equal((await f.call('/api/agent/check-send', { key: f.key, token: f.token, tool })).status, 403);
  } finally { await f.close(); }
});

test('单独启用 reserved2 的 sticker/voice/poke 真实 HTTP 正例', async () => {
  const f = await fixture('reserved2', { modes: { engine: { reserved2: true } }, socialV2: { tools: { sendVoice: true }, voice: { enabled: true, autoReadback: false } } }, {
    safeFetchBuffer: async () => ({ buffer: Buffer.from('fixture-image') }),
    inspectAudio: async () => ({ ok: true, size: 48, duration: 1, codec: 'pcm' }),
  });
  try {
    fs.mkdirSync(`${f.h.temp}/audio`, { recursive: true });
    fs.writeFileSync(`${f.h.temp}/audio/hello.wav`, Buffer.alloc(48));
    f.h.bot.getGroupMemberList = (id) => f.h.bot.request('get_group_member_list', { group_id: id });
    const pokes = [];
    f.h.bot.raw = async (action, params) => { pokes.push({ action, params }); return {}; };
    const sticker = await f.call('/api/agent/send-sticker', { key: f.key, stickerId: 'fixture-sticker' });
    assert.equal(sticker.status, 200, JSON.stringify(sticker));
    const voice = await f.call('/api/agent/send-voice', { key: f.key, voice: 'hello.wav', verify: false });
    assert.equal(voice.status, 200, JSON.stringify(voice));
    const poke = await f.call('/api/agent/send-poke', { key: f.key, targetUserId: '111' });
    assert.equal(poke.status, 200, JSON.stringify(poke));
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg') && call.body.message.some((part) => part.type === 'image')).length, 1);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg') && call.body.message.some((part) => part.type === 'record')).length, 1);
    assert.deepEqual(pokes, [{ action: 'group_poke', params: { group_id: 456, user_id: 111 } }]);
  } finally { await f.close(); }
});

test('单模式 enabledTools 按发送组、deny、回合控制组过滤', async () => {
  for (const mode of Object.keys(enabled)) {
    const f = await fixture(mode, { modes: { engine: { [mode]: true } }, socialV2: { tools: { sendVoice: true }, voice: { enabled: true } } });
    try {
      const result = await f.call(`/api/agent/prompt?key=${f.key}`);
      assert.equal(result.status, 200, JSON.stringify(result));
      const tools = result.body.enabledTools.join('\n');
      assert.equal(tools.includes('qq_send_message'), mode !== 'chat');
      assert.equal(tools.includes('qq_send_burst'), ['reserved2', 'closed-agent'].includes(mode));
      assert.equal(tools.includes('qq_send_voice'), ['reserved2', 'closed-agent'].includes(mode));
      assert.equal(tools.includes('qq_mark_read'), ['reserved2', 'closed-agent'].includes(mode));
    } finally { await f.close(); }
  }
});


test('agent HTTP preserves numeric message IDs through recent/unread, detail and reply, even when equal to a known QQ', async () => {
  const f = await fixture('reserved2');
  try {
    f.h.observeIdentity({ qq: '22222', group: '456', nickname: '小王' });
    const st = f.h.getSocialV2State(f.key);
    f.h.bot.getMessage = async messageId => ({ message_id: messageId, group_id: 456, sender: { user_id: 22222, nickname: '小王' }, message: [{ type: 'text', data: { text: '消息' } }] });
    const ids = ['987654321', '22222', '-987654321'];
    st.recentMessages = ids.map((messageId, i) => ({ messageId, seq: i + 1, sender: '小王', userId: '22222', text: '消息', replyToMessageId: '22222', id: '22222' }));
    st.unread = [...st.recentMessages];
    for (const route of ['recent', 'unread']) {
      const result = await f.call(`/api/agent/${route}?key=${f.key}`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.messages.map(item => item.messageId), ids);
      for (const item of result.body.messages) {
        assert.equal(item.userId, undefined);
        assert.equal(item.replyToMessageId, '22222');
        assert.equal(item.id, '22222');
      }
    }
    for (const messageId of ids) {
      const detail = await f.call(`/api/agent/message-detail?key=${f.key}&messageId=${messageId}`);
      assert.equal(detail.status, 200, JSON.stringify(detail));
      assert.equal(detail.body.messageId, messageId);
      assert.equal(detail.body.info.text, '消息');
      const reply = await f.call('/api/agent/send/reply', { key: f.key, groupId: '456', message: '回复', replyToMessageId: detail.body.messageId });
      assert.equal(reply.status, 200, JSON.stringify(reply));
      const sent = f.h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).at(-1);
      assert.equal(sent.body.message[0].type, 'reply');
      assert.equal(sent.body.message[0].data.id, messageId);
    }
    assert.deepEqual(f.h.projectForModel({ id: 22222, seq: '22222', source_msg_ids: ['22222'], extraRecipient: 22222 }), {
      id: 22222, seq: '22222', source_msg_ids: ['22222'], extraRecipient: '小王',
    });
  } finally { await f.close(); }
});


for (const expose of [false, true]) test(`poke HTTP projects identity IDs while preserving message IDs (exposeQqInPrompt=${expose})`, async () => {
  const f = await fixture('reserved2', { identity: { exposeQqInPrompt: expose } });
  try {
    const target = '23456';
    f.h.bot.getGroupMemberList = async () => [{ user_id: Number(target), nickname: '群友' }];
    const sent = [];
    f.h.bot.raw = async (action, params) => { sent.push({ action, params }); return {}; };
    const poke = await f.call('/api/agent/send-poke', { key: f.key, targetUserId: target });
    assert.equal(poke.status, 200, JSON.stringify(poke));
    assert.equal(poke.body.targetUserId, expose ? target : '群友');
    assert.deepEqual(sent, [{ action: 'group_poke', params: { group_id: 456, user_id: Number(target) } }]);
    const st = f.h.getSocialV2State(f.key);
    st.recentMessages.at(-1).messageId = target;
    const recent = await f.call(`/api/agent/recent?key=${f.key}`);
    assert.equal(recent.status, 200);
    const record = recent.body.messages.at(-1);
    assert.equal(record.poke.targetId, expose ? target : '群友');
    assert.equal(record.messageId, target);
    assert.equal(record.text.includes(target), expose);
    assert.equal(f.h.projectForModel(st.recentMessages.at(-1), 'console').poke.targetId, target);
    assert.equal(st.recentMessages.at(-1).poke.targetId, target);
    for (const field of ['targetId', 'targetUserId', 'senderId', 'target_id', 'target_user_id', 'sender_id']) {
      for (const value of [target, Number(target)]) {
        assert.equal(f.h.projectForModel({ [field]: value })[field], expose ? value : '群友');
      }
    }
  } finally { await f.close(); }
});

test('C-01：/api/agent/prompt 返回 self.userId 不污染 modelSourceQqs，遗留污染也不阻断发送与写记忆', async () => {
  const policy = JSON.stringify({
    schemaVersion: 1,
    groups: { 'group:456': { mode: 'whitelist', rules: { 111: { flags: { respond: true, converse: true, context: true, memory: true } } } } },
  });
  const f = await fixture('reserved2', { architecture: { gateV2: true } });
  try {
    fs.writeFileSync(f.h.MEMBER_POLICY_FILE, policy);
    f.h.loadMemberPolicy();
    f.h.setSelfIdentity('机器人', '10002');
    const st = f.h.getSocialV2State(f.key);
    f.h.appendSocialV2Message(f.key, '群友111', '你好', '你好', false, false, 'm1', [], '111');
    const promptRes = await f.call(`/api/agent/prompt?key=${f.key}`);
    assert.equal(promptRes.status, 200);
    assert.ok(!(st.modelSourceQqs ?? []).includes('10002'), 'self.userId 不得进入 modelSourceQqs');
    const sendRes = await f.call('/api/agent/send-message', { key: f.key, messages: ['收到'] });
    assert.equal(sendRes.status, 200, JSON.stringify(sendRes));
    // 模拟历史已污染的 selfUserId，toolSources 与写守卫也应忽略自身 QQ
    st.modelSourceQqs = ['111', '10002'];
    const memRes = await f.call('/api/agent/memory-append', { key: f.key, category: 'activeTopic', content: '聊天', extra: { sourceMessageIds: ['m1'] } });
    assert.equal(memRes.status, 200, JSON.stringify(memRes));
    const sendAfterPolluted = await f.call('/api/agent/send-message', { key: f.key, messages: ['再发一句'] });
    assert.equal(sendAfterPolluted.status, 200, JSON.stringify(sendAfterPolluted));
  } finally { await f.close(); }
});

test('C-04：timeline 分条重规划保留逐条随机间隔并在扩容拆分时延续随机间隔', () => {
  const sleeps = [];
  const fakeCfg = { social: { burstEnabled: true, maxReplyChars: 20, burstIntervalMinMs: 10, burstIntervalMaxMs: 20, longGapProbability: 0.5, longGapMinMs: 80, longGapMaxMs: 90 } };
  const timelineB = {
    cfg: fakeCfg,
    splitLongSegment: (s, max) => {
      const out = [];
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      return out;
    },
    splitByCjkSpaces: (s) => s.split(/\s+/).filter(Boolean),
    singleLineForQQ: (s) => s,
    randInt: (min, max) => (min === 80 ? 85 : 15),
    enqueueOutbound: (_key, intent) => Promise.resolve({ sent: intent }),
  };
  const { planSocialTimeline, sendBurstToQQ } = createSendTimeline(timelineB);
  const origRandom = Math.random;
  const rolls = [0.1, 0.9]; // 第一段走 longGap (85ms)，第二段走普通 (15ms)
  Math.random = () => rolls.shift() ?? 0.9;
  let capturedIntent;
  timelineB.enqueueOutbound = async (_key, intent) => { capturedIntent = intent; return { sent: intent.batch.map(x => x.text) }; };
  try {
    const plan = planSocialTimeline('第一句 第二句 第三句', fakeCfg.social);
    sendBurstToQQ('group:456', plan.main, fakeCfg.social);
    const prepared = prepareOutboundItems(timelineB, 'group:456', capturedIntent, capturedIntent.batch.map(x => ({ ...capturedIntent, ...x })));
    assert.deepEqual(prepared.map(x => x.afterDelay), [85, 15, 0], '逐段间隔不得被 items[0].afterDelay 覆盖');

    // 当队列等待期间 maxReplyChars 收紧使段数变多时，新增中间段也应使用 nextTimelineDelay 且末段恒为 0
    timelineB.cfg.social.maxReplyChars = 2;
    const expanded = prepareOutboundItems(timelineB, 'group:456', capturedIntent, capturedIntent.batch.map(x => ({ ...capturedIntent, ...x })));
    assert.ok(expanded.length > 3);
    assert.equal(expanded[0].afterDelay, 85);
    assert.equal(expanded[1].afterDelay, 15);
    assert.ok(expanded.slice(2, -1).every(x => x.afterDelay === 15), '新增中间段应延续 nextTimelineDelay');
    assert.equal(expanded.at(-1).afterDelay, 0);
  } finally {
    Math.random = origRandom;
    void sleeps;
  }
});

test('C-05 / R-04：分条中途收紧字数仅拒绝超长段、放行后续短段，且同毫秒限频回滚不误删已提交', async () => {
  const h = await bridgeHarness({ config: { modes: { engine: enabled }, sendDelayMs: 0, socialV2: { send: { maxMessageChars: 10, maxSendPerMinute: 10, maxSendPerHour: 20 } } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const delivered = [];
    h.bot.sendGroupMessage = async (_gid, text) => {
      delivered.push(text);
      if (delivered.length === 1) h.cfg.socialV2.send.maxMessageChars = 4; // 第 0 条后收紧上限
      return { message_id: delivered.length };
    };
    await assert.rejects(
      () => h.enqueueOutbound(key, {
        ai: true, channel: 'tool', tool: 'sendBurst',
        batch: [{ text: 'first-7' }, { text: 'second8' }, { text: 'ok' }],
      }),
      err => {
        assert.deepEqual(err.sent, ['first-7', 'ok'], `第 0 条已发后第 1 条超长失败，但第 2 条短段仍应独立评估并发送: ${err?.message}`);
        return true;
      },
    );
    assert.deepEqual(delivered, ['first-7', 'ok']);

    // C-05: 中途关闭 burstEnabled 后剩余多条必须全部阻止
    h.cfg.socialV2.send.maxMessageChars = 50;
    const delivered2 = [];
    h.bot.sendGroupMessage = async (_gid, text) => {
      delivered2.push(text);
      h.cfg.socialV2.send.burstEnabled = false;
      return { message_id: delivered2.length };
    };
    await assert.rejects(
      () => h.enqueueOutbound(key, { ai: true, channel: 'tool', tool: 'sendBurst', batch: [{ text: 'a' }, { text: 'b' }] }),
      /已禁用多条发送/,
    );
    assert.deepEqual(delivered2, ['a']);

    // R-04: 同毫秒 commit + rollback 不得用 indexOf 误删已提交记录
    h.cfg.socialV2.send.burstEnabled = true;
    const origNow = Date.now;
    const fakeNow = origNow();
    Date.now = () => fakeNow;
    try {
      const rateSendTimes = [];
      let call = 0;
      const outbound = createOutbound({
        cfg: { socialV2: { send: { maxSendPerMinute: 2, maxSendPerHour: 10 } } },
        state: { sessions: { [key]: 's1' } },
        sendChainFor: () => Promise.resolve(),
        captureSendGuard: () => () => {},
        conversationEpoch: () => 0,
        lastSendFailed: new Map(),
        archiveOutgoing: () => {},
        rememberSendChain: () => {},
        log: () => {},
        redactSensitiveText: s => s,
        redactKnownTokensOnly: s => s,
        shouldAuditKey: () => false,
        hasKnownTokenFragment: () => false,
        modeForKey: () => 'chat',
        modeAdapterForKey: () => ({ sendPolicy: { mode: 'auto-text' }, toolPolicy: { groups: ['send'], deny: [] } }),
        v2ToolEnabled: () => true,
        text: s => s,
        getSocialV2State: () => ({ sendTimes: rateSendTimes }),
        bot: {
          sendGroupMessage: async () => {
            call++;
            if (call === 2) throw new Error('transport boom');
            return { message_id: call };
          },
        },
        withTimeout: p => p,
        SEND_TIMEOUT_MS: 5000,
      });
      await assert.rejects(
        () => outbound.enqueueOutbound(key, { ai: true, rateScope: 'tool', batch: [{ text: 'x' }, { text: 'y' }] }),
        /transport boom/,
      );
      assert.equal(rateSendTimes.length, 1, '第 0 条已提交记录在同毫秒第 1 条回滚时不得被误删');
      await outbound.enqueueOutbound(key, { ai: true, rateScope: 'tool', text: 'z' });
      assert.equal(rateSendTimes.length, 2);
      await assert.rejects(
        () => outbound.enqueueOutbound(key, { ai: true, rateScope: 'tool', text: 'w' }),
        /发送频率超限/,
      );
      outbound.resetOutbound(key);
      // 清除工具层时间数组后确认 AI 通道也被 reset 且新配额恢复
      rateSendTimes.length = 0;
      await outbound.enqueueOutbound(key, { ai: true, rateScope: 'tool', text: 'after-reset' });
      assert.equal(rateSendTimes.length, 1);
    } finally {
      Date.now = origNow;
    }
    void st;
  } finally { await h.close(); }
});
