// 门禁四开关接入入口后的集成回归：归档 / 未读与最近 / 给模型的快照 / 是否投递，各对应一个开关
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { filterAndProjectGroupHistory } from '../src/gate/mcp-history.js';

const rule = (respond, converse, context, memory) => ({ flags: { respond, converse, context, memory } });
const policy = JSON.stringify({
  schemaVersion: 1,
  groups: { 'group:456': { mode: 'all', rules: {
    101: rule(false, true, true, true), // 观察者
    102: rule(true, true, true, false), // 不落盘
    103: rule(false, false, false, false), // 完全屏蔽
    104: rule(true, true, false, true), // 历史不可见
    105: rule(false, false, true, true), // 仅背景记忆
  } } },
});
const ev = (userId, text) => ({
  post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
  user_id: userId, message_id: userId * 10, time: 1762687719,
  sender: { nickname: `u${userId}` }, message: [{ type: 'text', data: { text } }],
});
const senders = [999, 101, 102, 103, 104, 105];
const boot = (gateV2, file = policy, extra = {}) => bridgeHarness({
  config: { archive: { enabled: true }, memory: { enabled: true, minMessages: 2 }, sendDelayMs: 0, socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } }, architecture: { gateV2 }, ...extra },
  files: { 'state/member-policy.json': file },
});
const archived = (h) => h.messageArchive.range('group:456').filter((r) => r.from === 'user').map((r) => Number(r.user_id)).sort();

test('reserved2：memory 管归档，converse 管最近记录，respond 管未读，context 管历史可见', async () => {
  const h = await boot(true);
  try {
    h.setMode('reserved2');
    for (const id of senders) await h.acceptPipelineMessage('group', ev(id, `msg-${id}`), h.cfg);
    const st = h.getSocialV2State('group:456');
    const ids = (list) => list.map((m) => Number(m.userId)).sort();

    assert.deepEqual(archived(h), [101, 104, 105, 999], 'memory=false 的 102/103 不进底账');
    assert.deepEqual(ids(st.recentMessages), [101, 102, 104, 999], 'converse=false 的 103/105 不进会话状态');
    assert.deepEqual(ids(st.unread), [102, 104, 999], 'respond=false 的 101 不进未读');
    assert.equal(st.lastUnreadSeq, 3, '不进未读的消息不占 seq');
    assert.deepEqual(st.unread.map((m) => m.seq), [1, 2, 3], '水位连续，不会被堵');

    const before = JSON.stringify(h.buildWakeSnapshotV2('group:456'));
    assert.ok(!before.includes('msg-104'), 'F-14：未读快照也是历史读取面，context=false 不渲染');
    assert.ok(before.includes('msg-102'), 'memory=false/context=true 仍然可读');
    st.unread = [];
    st.lastReadThroughSeq = st.lastUnreadSeq;
    const after = JSON.stringify(h.buildWakeSnapshotV2('group:456'));
    assert.ok(after.includes('msg-999') && after.includes('msg-101'), '普通成员和观察者的历史可见');
    assert.ok(!after.includes('msg-104'), 'context=false 的历史不渲染');

    // 归档侧：104 留在底账，但压缩时不交给模型，游标照常推进
    const rows = h.messageArchive.range('group:456');
    assert.deepEqual(rows.filter((r) => r.no_context).map((r) => Number(r.user_id)), [104]);
    const promptsBefore = h.calls.prompts.length;
    const run = h.compressConversation('group:456');
    for (let i = 0; i < 200 && h.calls.prompts.length === promptsBefore; i++) await new Promise((r) => setTimeout(r, 5));
    const sent = h.calls.prompts.at(-1);
    for (let i = 0; i < 200 && !h.completeLearnerTurn(sent?.sessionId, '[]'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await run).toSeq, rows.at(-1).seq);
    const compressPrompt = JSON.stringify(sent);
    assert.ok(compressPrompt.includes('msg-999') && compressPrompt.includes('msg-105'), '普通成员和仅背景记忆的成员进压缩');
    assert.ok(!compressPrompt.includes('msg-104'), 'context=false 的消息不进压缩');
  } finally { await h.close(); }
});

test('二代只向当前消息唤醒提供单条 noContext 输入，不恢复历史未读', async () => {
  const h = await boot(true);
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.unread = [
      { seq: 1, userId: '104', sender: '群友', text: '隐藏的旧输入', noContext: true },
      { seq: 2, userId: '104', sender: '群友', text: '仅本回合当前输入', noContext: true },
    ];
    st.recentMessages = [...st.unread];
    const current = h.buildWakePromptV2('group:456', 'at@seq2');
    assert.ok(current.includes('仅本回合当前输入'));
    assert.ok(!current.includes('隐藏的旧输入'));
    assert.ok(h.buildWakePromptV2('group:456', 'bootstrap').includes('仅本回合当前输入'));
    assert.ok(!h.buildWakePromptV2('group:456', 'proactiveCheck').includes('仅本回合当前输入'));
    assert.ok(!JSON.stringify(h.buildWakeSnapshotV2('group:456')).includes('仅本回合当前输入'));
    st.unread = [];
    assert.ok(!h.buildWakePromptV2('group:456', 'at@seq2').includes('仅本回合当前输入'));
  } finally { await h.close(); }
});

test('chat：respond=false 不投递，其余照常；开关关闭时策略文件不生效', async () => {
  const on = await boot(true);
  try {
    on.setMode('chat');
    for (const id of senders) {
      await on.acceptPipelineMessage('group', ev(id, `msg-${id}`), on.cfg);
      const sid = on.state.sessions['group:456'];
      on.scheduledTurnEvent('group:456', sid, { type: 'turn/start', data: { turn: `t-${id}` } });
      on.settleScheduledTurn('group:456', sid, `t-${id}`);
    }
    const prompts = JSON.stringify(on.calls.prompts);
    for (const id of [999, 102, 104]) assert.ok(prompts.includes(`msg-${id}`), `${id} 应投递`);
    for (const id of [101, 103, 105]) assert.ok(!prompts.includes(`msg-${id}`), `${id} 不应投递`);
    assert.deepEqual(archived(on), [101, 104, 105, 999]);
  } finally { await on.close(); }

  const off = await boot(false);
  try {
    off.setMode('chat');
    for (const id of senders) await off.acceptPipelineMessage('group', ev(id, `msg-${id}`), off.cfg);
    const prompts = JSON.stringify(off.calls.prompts);
    for (const id of senders) assert.ok(prompts.includes(`msg-${id}`), `${id} 应投递`);
    assert.deepEqual(archived(off), [...senders].sort());
  } finally { await off.close(); }
});

test('策略文件损坏：群里一律不回应，但不丢归档', async () => {
  const h = await boot(true, '{oops');
  try {
    h.setMode('chat');
    await h.acceptPipelineMessage('group', ev(999, 'msg-999'), h.cfg);
    assert.equal(JSON.stringify(h.calls.prompts).includes('msg-999'), false);
    assert.deepEqual(archived(h), [999]);
  } finally { await h.close(); }
});

test('发送时复查：捕获前已设 respond=false 的私聊对象，AI 回复不发出；非 AI 发送、owner 与开关关闭不受影响', async () => {
  const priv = JSON.stringify({ schemaVersion: 1, private: { 201: { respond: false, converse: true, context: true, memory: true } } });
  for (const gateV2 of [true, false]) {
    const h = await boot(gateV2, priv, { allow: { private: ['123', '201'], groups: ['456'] } });
    try {
      h.setMode('chat');
      await h.sendToQQ('private:201', 'ai-reply', { ai: true });
      await h.sendToQQ('private:201', 'owner-notice');
      await h.sendToQQ('private:123', 'ai-owner', { ai: true });
      const texts = JSON.stringify(h.calls.sent);
      assert.equal(texts.includes('ai-reply'), !gateV2, `gateV2=${gateV2}`);
      assert.ok(texts.includes('owner-notice') && texts.includes('ai-owner'));
    } finally { await h.close(); }
  }
});

test('发送时复查在真正发送前重算：捕获后改成员策略/忽略名单，排队中的 AI 私聊回复被取消', async () => {
  const allow201 = JSON.stringify({ schemaVersion: 1, private: { 201: { respond: true, converse: true, context: true, memory: true } } });
  const block201 = JSON.stringify({ schemaVersion: 1, private: { 201: { respond: false, converse: true, context: true, memory: true } } });
  const h = await boot(true, allow201, { allow: { private: ['123', '201'], groups: ['456'] } });
  try {
    h.setMode('chat');
    // 捕获发送之后、链真正执行之前改规则：如果复查被前移到捕获时，这里会漏发
    const blocked = h.sendToQQ('private:201', 'timing-blocked', { ai: true });
    fs.writeFileSync(h.MEMBER_POLICY_FILE, block201);
    h.loadMemberPolicy();
    await blocked;
    assert.ok(!JSON.stringify(h.calls.sent).includes('timing-blocked'), '捕获后改成 respond=false 仍应取消');

    // deny 分支：捕获后加入 ignore.sendQQ
    const ignored = h.sendToQQ('private:201', 'timing-ignored', { ai: true });
    h.cfg.ignore = { sendQQ: ['201'] };
    await ignored;
    assert.ok(!JSON.stringify(h.calls.sent).includes('timing-ignored'), '捕获后被忽略也应取消');

    await h.sendToQQ('private:123', 'timing-owner', { ai: true });
    assert.ok(JSON.stringify(h.calls.sent).includes('timing-owner'), 'owner 不受影响');
  } finally { await h.close(); }
});

test('发送工具路径（sendMessagesV2）同样受发送时复查约束', async () => {
  const block201 = JSON.stringify({ schemaVersion: 1, private: { 201: { respond: false, converse: true, context: true, memory: true } } });
  const h = await boot(true, block201, { allow: { private: ['123', '201'], groups: ['456'] } });
  try {
    h.setMode('reserved2');
    await assert.rejects(() => h.sendMessagesV2('private:201', ['tool-reply'], [], null), /成员策略不允许回应/);
    assert.ok(!JSON.stringify(h.calls.http).includes('tool-reply'), '工具路径也不应发出');

    await h.sendMessagesV2('private:123', ['owner-tool'], [], null);
    assert.ok(JSON.stringify(h.calls.http).includes('owner-tool'), 'owner 工具发送照常');
  } finally { await h.close(); }
});

// 群回应必须绑定引发当前回合的成员，而非发送目标群号。
test('群回合排队发送期间修改来源成员策略，会在真正传输前取消', async () => {
  const h = await boot(true);
  try {
    h.setMode('chat');
    await h.acceptPipelineMessage('group', ev(999, '触发群回合'), h.cfg);
    assert.deepEqual(h.turnEngine.activeRequest('group:456').payload.sourceQqs, ['999']);
    const sending = h.sendToQQ('group:456', '取消的群回复', { ai: true });
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { 'group:456': { mode: 'all', rules: { 999: rule(false, true, true, true) } } } }));
    h.loadMemberPolicy();
    await sending;
    assert.equal(h.calls.sent.some(item => item.text === '取消的群回复'), false);
  } finally { await h.close(); }
});

test('F-15/N-04/N-05/N-06/N-07/N-09/N-10：门禁剩余边界（无来源拒绝、身份名单/记忆过滤、converse=false、拍一拍、mark-read 水位、AI 全局速率）', async () => {
  const h = await boot(true);
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');

    // F-15：群 AI 发送在缺少来源或 modelSourcesIncomplete 时必须 fail-closed，非 AI 系统通知不受影响
    await h.sendToQQ('group:456', '无来源AI回复', { ai: true });
    assert.equal(h.calls.sent.some(item => item.text === '无来源AI回复'), false, '无来源群 AI 发送必须被拒');
    await h.sendToQQ('group:456', '系统通知', { ai: false });
    assert.equal(h.calls.sent.some(item => item.text === '系统通知'), true, '非 AI 发送不受群成员来源限制');

    // N-04：renderIdentityRoster 按 context 过滤成员
    h.observeIdentity({ qq: '999', group: '456', nickname: '可见群友', card: '可见群友' });
    h.observeIdentity({ qq: '104', group: '456', nickname: '隐藏群友', card: '隐藏群友' });
    const roster = h.renderIdentityRoster('group:456');
    assert.ok(roster.includes('可见群友'), 'context=true 成员应出现在身份目录');
    assert.ok(!roster.includes('隐藏群友'), 'context=false 成员不应出现在身份目录');

    // N-05：converse=false (105) 不进 recentMessages、不推进 lastIncomingAt、不执行斜杠命令
    st.recentMessages = [];
    st.unread = [];
    st.lastIncomingAt = 0;
    const roleBefore = h.readRoleState().role;
    await h.acceptPipelineMessage('group', ev(105, '/role EvilRole'), h.cfg);
    assert.equal(st.recentMessages.length, 0, 'converse=false 不进 recentMessages');
    assert.equal(st.lastIncomingAt, 0, 'converse=false 不推进 lastIncomingAt');
    assert.equal(h.readRoleState().role, roleBefore, 'converse=false 不触发斜杠命令');

    // N-06：拍一拍遵守成员四开关（105 converse=false 不记录，101 respond=false 不进未读，104 context=false 标记 noContext）
    await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 105, target_id: 10002, self_id: 10002 });
    assert.equal(st.recentMessages.length, 0, 'converse=false 的拍一拍不进 recentMessages');
    assert.equal(st.lastIncomingAt, 0, 'converse=false 的拍一拍不推进 lastIncomingAt');
    await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 101, target_id: 10002, self_id: 10002 });
    assert.equal(st.recentMessages.length, 1, 'respond=false/converse=true 的拍一拍进 recentMessages');
    assert.equal(st.unread.length, 0, 'respond=false 的拍一拍不进 unread');
    await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 104, target_id: 10002, self_id: 10002 });
    assert.equal(st.unread.length, 1, 'respond=true 的拍一拍进 unread');
    assert.equal(st.unread[0].noContext, true, 'context=false 的拍一拍标记 noContext');

    // N-07：agent 调 requestedReadThroughSeqV2 省略 throughSeq 时只确认已展示连续水位，不越过未展示消息
    st.unread = [
      { seq: 1, userId: '999', sender: 'u999', text: '已展示' },
      { seq: 2, userId: '999', sender: 'u999', text: '未展示' },
    ];
    st.lastUnreadSeq = 2;
    st.lastReadThroughSeq = 0;
    st.modelSeenSeqs = new Set([1]);
    assert.equal(h.requestedReadThroughSeqV2(st, {}, true), 1, 'agent 省略 throughSeq 只到已展示连续水位 1');
    assert.equal(h.requestedReadThroughSeqV2(st, {}, false), null, '控制台省略 throughSeq 返回 null（由 acknowledgeMessagesV2 全清）');

    // N-10：formatMemoryV2 与 getMemoryContext 按目标成员 context 过滤
    st.memberImpressions = {
      999: { displayName: '可见群友', traits: ['热心'], interactionCount: 2 },
      104: { displayName: '隐藏群友', traits: ['神秘'], interactionCount: 2 },
    };
    const memV2 = h.formatMemoryV2(st);
    assert.ok(memV2.includes('热心'), 'context=true 印象保留');
    assert.ok(!memV2.includes('神秘'), 'context=false 印象过滤');
    h.memoryPool.update(items => [
      ...items,
      {
        id: 'm-visible', conv_id: 'group:456', scope: 'group', kind: 'preference', subject_uid: '999',
        content: '喜欢茶', confidence: 0.9, status: 'active', source_msg_ids: ['1'], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      {
        id: 'm-hidden', conv_id: 'group:456', scope: 'group', kind: 'preference', subject_uid: '104',
        content: '喜欢咖啡', confidence: 0.9, status: 'active', source_msg_ids: ['2'], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    ]);
    const memCtx = h.getMemoryContext('group:456');
    assert.ok(memCtx.includes('喜欢茶'), 'context=true 长期记忆保留');
    assert.ok(!memCtx.includes('喜欢咖啡'), 'context=false 长期记忆过滤');
  } finally { await h.close(); }

  // N-09：modes.engine 关闭时，AI 发送仍然走全局 AI 速率限制
  const rateLimited = await bridgeHarness({
    config: { modes: { engine: false }, socialV2: { send: { maxSendPerMinute: 1, maxSendPerHour: 10 } }, sendDelayMs: 0 },
  });
  try {
    rateLimited.setMode('chat');
    await rateLimited.enqueueOutbound('group:456', { text: '第一条AI', ai: true, channel: 'timeline' });
    assert.rejects(
      () => rateLimited.enqueueOutbound('group:456', { text: '第二条AI', ai: true, channel: 'timeline' }),
      /发送频率超限/,
    );
  } finally { await rateLimited.close(); }
});

test('C-02 / R-01：私聊 context=false 与 legacy 印象受门禁过滤，控制台保留读取', async () => {
  const mixedPolicy = JSON.stringify({
    schemaVersion: 1,
    private: {
      123: { respond: true, converse: true, context: false, memory: true },
    },
    groups: {
      'group:456': {
        mode: 'all',
        rules: {
          999: rule(true, true, true, true),
          104: rule(true, true, false, true),
        },
      },
    },
  });
  const h = await boot(true, mixedPolicy, {
    allow: { groups: ['456'], private: ['123'] },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const callApi = async (pathname, { admin = false, token = '' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      headers: {
        'x-console-token': 'fixture-console-token',
        ...(admin ? {} : { 'x-agent-call': '1', 'x-agent-token': token }),
      },
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    h.setMode('reserved2');
    const privKey = 'private:123';
    const privSt = h.getSocialV2State(privKey);
    privSt.activeTopics = [{ text: '私聊秘密话题', lastMentionAt: Date.now() }];
    privSt.pendingThoughts = [{ text: '私聊未说想法' }];
    privSt.memberImpressions = { 123: { displayName: '私聊对象', traits: ['私密特质'], interactionCount: 3 } };
    h.terms.append('global', '全局黑话', { meaning: '公共梗', sourceMessageIds: ['g1'] });
    h.terms.append(privKey, '私聊黑话', { meaning: '私人暗号', sourceMessageIds: ['p1'] });
    h.memoryPool.update((items) => [
      ...items,
      { id: 'priv-ev', conv_id: privKey, scope: 'private', kind: 'event', subject_uid: '123', content: '私聊事件', importance: 4, status: 'active', source_msg_ids: ['1'], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 'priv-sum', conv_id: privKey, scope: 'private', kind: 'summary', subject_uid: '', content: '私聊摘要', importance: 4, status: 'active', source_msg_ids: ['1'], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ]);

    // C-02: formatMemoryV2 / getMemoryContext / agent HTTP 在 private context=false 下全隐藏
    assert.equal(h.formatMemoryV2(privSt, privKey), '', '私聊 context=false 不应生成轻量记忆');
    const privCtx = h.getMemoryContext(privKey, privSt);
    assert.ok(!privCtx.includes('私聊秘密话题'));
    assert.ok(!privCtx.includes('私聊事件'));
    assert.ok(!privCtx.includes('私聊摘要'));
    assert.ok(!privCtx.includes('私聊黑话'));
    assert.ok(privCtx.includes('全局黑话'), '私聊隐藏不抹掉全局术语');

    const agentPrivMem = await callApi(`/api/agent/memory?key=${privKey}`, { token: privSt.agentToken });
    assert.equal(agentPrivMem.status, 200);
    assert.equal(agentPrivMem.data.formatted, '');
    assert.deepEqual(agentPrivMem.data.raw.activeTopics, []);
    assert.deepEqual(agentPrivMem.data.raw.pendingThoughts, []);
    assert.deepEqual(agentPrivMem.data.raw.memberImpressions, {});
    assert.deepEqual(agentPrivMem.data.long, []);
    assert.deepEqual(agentPrivMem.data.terms.map((t) => t.content), ['全局黑话']);

    const agentPrivEvent = await callApi(`/api/agent/memory?key=${privKey}&category=event`, { token: privSt.agentToken });
    assert.deepEqual(agentPrivEvent.data.items, [], 'category=event 不得绕过 private context=false');
    const agentPrivTerm = await callApi(`/api/agent/memory?key=${privKey}&category=term`, { token: privSt.agentToken });
    assert.deepEqual(agentPrivTerm.data.items.map((t) => t.content), ['全局黑话']);

    const consolePrivEvent = await callApi(`/api/console/memory?key=${privKey}&category=event`, { admin: true });
    assert.equal(consolePrivEvent.data.items.length, 1, '控制台仍可读私聊记忆');

    // R-01: gateV2 下 legacy: 印象与未解析长期记忆 fail-closed
    const grpKey = 'group:456';
    const grpSt = h.getSocialV2State(grpKey);
    grpSt.memberImpressions = {
      999: { displayName: '可见', traits: ['正常印象'], interactionCount: 1 },
      104: { displayName: '隐藏QQ', traits: ['QQ隐藏特质'], interactionCount: 1 },
      'legacy:小王': { displayName: '小王', traits: ['旧legacy敏感印象'], interactionCount: 2 },
    };
    const grpMemText = h.formatMemoryV2(grpSt, grpKey);
    assert.ok(grpMemText.includes('正常印象'));
    assert.ok(!grpMemText.includes('QQ隐藏特质'));
    assert.ok(!grpMemText.includes('旧legacy敏感印象'), 'R-01: legacy 印象在 gateV2 下 fail-closed');

    const agentGrpMem = await callApi(`/api/agent/memory?key=${grpKey}`, { token: grpSt.agentToken });
    const grpImpressions = Object.values(agentGrpMem.data.raw.memberImpressions);
    assert.equal(grpImpressions.length, 1, '仅可见 QQ 999 保留，104 与 legacy:小王 已过滤');
    assert.deepEqual(grpImpressions[0].traits, ['正常印象']);
    assert.ok(!agentGrpMem.data.formatted.includes('legacy'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('R-05：MCP 历史过滤复用 gate/decide（owner 隐私、名单、坏策略、未知 QQ 遮罩）', () => {
  const cfg = {
    ownerQQ: '10000',
    allow: { groups: ['456'] },
    ignore: { sendQQ: ['777'] },
    architecture: { gateV2: true },
  };
  const policyDoc = {
    schemaVersion: 1,
    groups: {
      'group:456': {
        mode: 'whitelist',
        rules: {
          10000: { flags: { respond: true, converse: true, context: false, memory: true } }, // owner context=false
          222: { flags: { respond: true, converse: true, context: true, memory: true } },
          333: { flags: { respond: true, converse: true, context: false, memory: true } },
        },
      },
    },
  };
  const rawMessages = [
    { message_id: 1, user_id: 10000, sender: { user_id: 10000, nickname: '主人' }, raw_message: 'owner hidden' },
    { message_id: 2, user_id: 777, sender: { user_id: 777, nickname: '忽略' }, raw_message: 'ignored user' },
    { message_id: 3, user_id: 999, sender: { user_id: 999, nickname: '陌生人' }, raw_message: 'not in whitelist' },
    { message_id: 4, user_id: 333, sender: { user_id: 333, nickname: '隐藏成员' }, raw_message: 'secret from 333' },
    { message_id: 5, user_id: 222, sender: { user_id: 222, nickname: '阿明' }, raw_message: 'ping @888888 and 333' },
  ];

  const projected = filterAndProjectGroupHistory({ groupId: '456', data: rawMessages, cfg, policy: policyDoc, policyBroken: false, identityPeople: {} });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].message_id, 5);
  assert.ok(!projected[0].raw_message.includes('333'), '被过滤成员 QQ 仍被遮罩为 群友');
  assert.ok(!projected[0].raw_message.includes('888888'), '@未知 QQ 也应遮罩为 群友');

  const broken = filterAndProjectGroupHistory({ groupId: '456', data: rawMessages, cfg, policy: policyDoc, policyBroken: true, identityPeople: {} });
  assert.deepEqual(broken, [], '坏策略时 MCP 历史查询 fail-closed');
});

test('控制台管理视图保留隐藏上下文，agent wait/mark-read/wake-config 返回可见未读计数且不污染 modelSourceQqs', async () => {
  const policyDoc = JSON.stringify({
    schemaVersion: 1,
    groups: {
      'group:456': {
        mode: 'all',
        rules: {
          999: rule(true, true, true, true),
          104: rule(false, true, false, false),
        },
      },
    },
  });
  const h = await boot(true, policyDoc, { allow: { groups: ['456'] }, socialV2: { wait: { minMs: 100, defaultMs: 100 }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.unread = [
    { seq: 1, sender: '可见', userId: '999', text: '普通消息', sourceQqs: ['999'], time: Date.now() },
    { seq: 2, sender: '隐藏', userId: '104', noContext: true, text: '隐藏消息', sourceQqs: ['104'], time: Date.now() },
  ];
  st.lastUnreadSeq = 2;
  st.recentMessages = [...st.unread];
  st.memberImpressions = {
    104: { displayName: '隐藏', traits: ['私密印象'], interactionCount: 1 },
    'legacy:旧': { displayName: '旧', traits: ['legacy印象'], interactionCount: 1 },
  };

  // 管理视图放行，模型视图隐藏
  assert.ok(h.formatMemoryV2(st, 'group:456', { filterVisibility: false }).includes('legacy印象'));
  assert.ok(!h.formatMemoryV2(st, 'group:456').includes('legacy印象'));

  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const call = async (urlPath, opts = {}) => {
      const headers = {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'x-console-token': 'fixture-console-token',
        ...(opts.admin ? {} : { 'x-agent-call': '1', 'x-agent-token': st.agentToken }),
      };
      const res = await fetch(`${base}${urlPath}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
      return { status: res.status, data: await res.json() };
    };

    const consoleMem = await call('/api/console/memory?key=group:456', { admin: true });
    assert.equal(consoleMem.status, 200);
    assert.ok(consoleMem.data.formatted.includes('legacy印象'), '控制台 /api/console/memory formatted 应保留隐藏与 legacy 印象');

    // wake-config、unread 与 mark-read 返回过滤后的 unreadCount，且 noContext 的 104 不进入 modelSourceQqs
    const wc = await call('/api/agent/wake-config', { method: 'POST', body: { key: 'group:456', config: { mode: 'active', infinite: true } } });
    assert.equal(wc.status, 200, wc.data?.error);
    assert.equal(wc.data.unreadCount, 1);

    const unreadRes = await call('/api/agent/unread?key=group:456');
    assert.equal(unreadRes.status, 200);
    assert.equal(unreadRes.data.unreadCount, 1);
    assert.ok(!st.modelSourceQqs?.includes('104'), 'unread 曝光前不得把 noContext 的 104 计入 modelSourceQqs');

    const mk = await call('/api/agent/mark-read', { method: 'POST', body: { key: 'group:456', throughSeq: 1 } });
    assert.equal(mk.status, 200, mk.data?.error);
    assert.equal(mk.data.unreadCount, 0, 'agent mark-read 不应把隐藏的 noContext 消息计入 unreadCount');
    assert.ok(!st.modelSourceQqs?.includes('104'), '未向模型曝光的 noContext 消息不得污染 modelSourceQqs');

    const waitRes = await call('/api/agent/wait', { method: 'POST', body: { key: 'group:456', timeoutMs: 100 } });
    assert.equal(waitRes.status, 200, waitRes.data?.error);
    assert.equal(waitRes.data.unreadCount, 0, 'agent wait 不应把隐藏的 noContext 消息计入 unreadCount');
    assert.ok(!st.modelSourceQqs?.includes('104'), 'wait 后未曝光的 noContext 消息仍不得污染 modelSourceQqs');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});
