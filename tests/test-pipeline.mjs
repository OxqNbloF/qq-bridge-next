// 消息管线纯函数：信封构造与旧入口文本一致、@/引用保留 QQ、坏事件丢弃、去重
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildEnvelope, parseSegments } from '../src/pipeline/envelope.js';
import { createDeduper } from '../src/pipeline/dedupe.js';
import { createPipelineAccept } from '../src/pipeline/accept.js';
import { createInboundFilter } from '../src/inbound/filter.js';
import { segmentsToText, extractMediaFromSegments } from '../src/inbound/normalize.js';

const names = { 222: '老王' };
const resolveAtName = async (qq) => names[qq] ?? null;
const seg = (type, data = {}) => ({ type, data });
const group = (message, extra = {}) => ({
  group_id: 789, user_id: 111, self_id: 999, message_id: 42, time: 1700000000,
  sender: { user_id: 111, card: '阿凉', nickname: 'liang' }, message, ...extra,
});

test('filter 只暴露管线预检与处理，不再暴露无生产调用方的兼容入口', () => {
  assert.deepEqual(Object.keys(createInboundFilter({})).sort(), ['prepareIncoming', 'processIncoming']);
});

test('filter 不直接持有归档和媒体缓存，实现交给独立入站记录模块', () => {
  const source = fs.readFileSync(new URL('../src/inbound/filter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /messageMediaStore|MAX_MEDIA_STORE_PER_KEY|memoryAPI\.record/);
});

test('filter 只协调阶段，不实现门禁/身份观察/挂起审批/角色与命令控制', () => {
  const source = fs.readFileSync(new URL('../src/inbound/filter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /gateDecide|observeIdentity|pending\.get|readRoleState|handleInboundCommand|角色切换|\.test\(/);
});

function inboundFixture({ plain = 'hello', media = [], flags = {}, owner = false, quote = false, allowed = true, duplicate = false } = {}) {
  const calls = [];
  const envelope = {
    id: '42', seq: 0, text: plain, plain, media, mentions: [],
    sender: { displayName: 'fixture', isOwner: owner },
    raw: { user_id: owner ? 1 : 111, self_id: 999, message_seq: 43, message: [] },
  };
  const prepared = { key: 'group:789', kind: 'group', id: '789', flags: { respond: true, converse: true, context: true, memory: true, ...flags } };
  const b = {
    messageMediaStore: new Map(), MAX_MEDIA_STORE_PER_KEY: 2,
    isQuoteTargetSelf: async () => { calls.push('quote'); return quote; },
    isSessionAllowedInCurrentMode: () => { calls.push('session'); return allowed; },
    memoryAPI: { record: () => { calls.push('archive'); return { duplicate, written: !duplicate, seq: 7 }; } },
    readRoleState: () => ({ mode: 'active' }), pending: new Map(),
    gateDecide: () => ({ allowed: true }), modeForKey: () => 'chat',
    handleInboundCommand: async () => { calls.push('command'); return false; },
    dispatchModeMessage: (input) => { calls.push('dispatch'); return input; },
  };
  return { b, calls, envelope, prepared, process: () => createInboundFilter(b).processIncoming(envelope, {}, prepared) };
}

test('纯媒体先缓存双引用并归档，空文本不分发；缓存按会话有界淘汰', async () => {
  const f = inboundFixture({ plain: '', media: [{ type: 'image', url: 'fixture' }] });
  f.b.messageMediaStore.set('group:789', new Map([['old', []]]));
  await f.process();
  assert.deepEqual(f.calls, ['quote', 'session', 'archive']);
  assert.deepEqual([...f.b.messageMediaStore.get('group:789')], [['42', f.envelope.media], ['43', f.envelope.media]]);
  assert.equal(f.envelope.seq, 7);
});

test('归档重复不执行命令/分发；memory=false 不归档但仍缓存并分发', async () => {
  const duplicate = inboundFixture({ duplicate: true, plain: '/fixture' });
  await duplicate.process();
  assert.deepEqual(duplicate.calls, ['quote', 'session', 'archive']);
  const noMemory = inboundFixture({ flags: { memory: false }, media: [{ type: 'image' }] });
  const result = await noMemory.process();
  assert.deepEqual(noMemory.calls, ['quote', 'session', 'dispatch']);
  assert.equal(result.envelope.seq, 0);
  assert.equal(noMemory.b.messageMediaStore.get('group:789').get('42'), noMemory.envelope.media);
});

test('会话不允许时不归档，引用自身的空文本仍可进入模式分发', async () => {
  const denied = inboundFixture({ allowed: false });
  await denied.process();
  assert.deepEqual(denied.calls, ['quote', 'session']);
  const quoted = inboundFixture({ plain: '', quote: true });
  assert.equal((await quoted.process()).quoteTargetIsSelf, true);
  assert.deepEqual(quoted.calls, ['quote', 'session', 'archive', 'dispatch']);
});

test('挂起审批仅 owner 消费，优先于静默/成员 flag/斜杠命令', async () => {
  for (const owner of [true, false]) {
    const f = inboundFixture({ owner, plain: '/approve', flags: { converse: false, respond: false } });
    const pending = { id: 'fixture' };
    f.b.pending.set('group:789', pending);
    f.b.handlePendingAnswer = async (...args) => { f.calls.push('answer'); assert.deepEqual(args, [pending, '/approve', 'group:789', true]); };
    f.b.gateDecide = () => { f.calls.push('runtime-gate'); return { allowed: false, reason: 'silent' }; };
    f.b.appendActivity = () => f.calls.push('activity');
    f.b.log = () => {};
    await f.process();
    assert.deepEqual(f.calls, owner ? ['quote', 'session', 'archive', 'answer'] : ['quote', 'session', 'archive', 'runtime-gate', 'activity']);
  }
});

test('角色控制语、斜杠命令与观察者按原有顺序处理，消费后不分发', async () => {
  const role = inboundFixture({ plain: '请切换角色' });
  role.b.sendToQQ = async () => role.calls.push('role-denied');
  await role.process();
  assert.deepEqual(role.calls, ['quote', 'session', 'archive', 'role-denied']);

  const command = inboundFixture({ plain: '/status', owner: true });
  command.b.handleInboundCommand = async (input) => { command.calls.push('command'); assert.equal(input.isOwner, true); return true; };
  await command.process();
  assert.deepEqual(command.calls, ['quote', 'session', 'archive', 'command']);

  const observer = inboundFixture({ plain: '切换角色', flags: { respond: false } });
  await observer.process();
  assert.deepEqual(observer.calls, ['quote', 'session', 'archive', 'dispatch']);
  const background = inboundFixture({ plain: '/fixture', flags: { converse: false, respond: false } });
  await background.process();
  assert.deepEqual(background.calls, ['quote', 'session', 'archive']);
});

test('预检先拒绝再观察身份，gateV2 关闭保留默认 flag', () => {
  for (const enabled of [true, false]) {
    const calls = [];
    const flags = { respond: false, converse: true, context: false, memory: false };
    let allowed = false;
    const b = {
      convKey: (kind, id) => `${kind}:${id}`, currentMode: 'chat', modeForKey: () => 'chat',
      gateDecide: (input) => { calls.push(input); return { allowed, flags, reason: 'fixture' }; },
      observeIdentity: (input) => calls.push(input), log: () => {},
    };
    const cfg = { architecture: { gateV2: enabled } };
    const f = createInboundFilter(b);
    assert.equal(f.prepareIncoming('group', '789', group([]), cfg), null);
    assert.equal(calls.length, 1);
    allowed = true;
    const prepared = f.prepareIncoming('group', '789', group([]), cfg);
    assert.equal(calls[1].applyMemberPolicy, enabled);
    assert.equal(calls[2].qq, '111');
    assert.deepEqual(prepared.flags, enabled ? flags : { respond: true, converse: true, context: true, memory: true });
  }
});

test('信封文本/媒体与旧入口逐字节一致', async () => {
  let lookups = 0;
  const resolveReply = async (id) => { lookups += 1; return { sender: '老王', text: `原文${id}`, userId: '222' }; };
  const messages = [
    [seg('text', { text: ' 你好 ' })],
    [seg('at', { qq: '222' }), seg('text', { text: ' 在吗' }), seg('at', { qq: 'all' }), seg('at', { qq: 333 })],
    [seg('reply', { id: 7 }), seg('text', { text: '对' })],
    [seg('image', { file: 'a.png', url: 'http://x/a', summary: '图' }), seg('mface', { summary: '笑', emoji_id: 'e1' }), seg('face', { id: 5 })],
    [seg('record'), seg('video'), seg('file', { name: 'a.txt' }), seg('json'), seg('markdown', { content: '# t' }), seg('forward', { id: 'f1' }), seg('weird')],
    '  纯字符串消息 ',
    [],
  ];
  for (const message of messages) {
    lookups = 0;
    const env = await buildEnvelope('group', group(message), { resolveAtName, resolveReply, ownerQQ: 1 });
    assert.ok(lookups <= 1, '同一条引用只查一次');
    assert.equal(env.text, await segmentsToText(message, { resolveAtName, resolveReply }));
    assert.equal(env.plain, await segmentsToText(message, { resolveAtName, includeReply: false }));
    assert.deepEqual(env.media, extractMediaFromSegments(Array.isArray(message) ? message : []));
  }
});

test('@、引用与文本别名保留结构化身份结果', async () => {
  const resolveReply = async () => ({ sender: '老王', text: '原文', userId: '222' });
  let aliasLookups = 0;
  const env = await buildEnvelope('group', group([seg('reply', { id: 7 }), seg('at', { qq: '222' }), seg('at', { qq: 'all' }), seg('at', { qq: 222 })]), {
    resolveAtName, resolveReply, ownerQQ: 111, resolveAlias: () => { aliasLookups++; return { ambiguous: true, qqs: ['222', '333'] }; },
    resolveAliases: () => ['阿凉', '凉']
  });
  assert.deepEqual(env.at, ['222']);
  assert.deepEqual(env.quote, { messageId: '7', senderQq: 222, text: '原文' });
  assert.deepEqual(env.sender, { qq: 111, displayName: '阿凉', aliases: ['阿凉', '凉'], isOwner: true });
  assert.deepEqual(env.mentions, [{ qq: '222', by: 'at' }]);
  assert.equal(aliasLookups, 0, 'authoritative @/reply structure suppresses whole-text alias lookup');
  assert.deepEqual([env.id, env.seq, env.conv, env.ts, env.flags], ['42', 0, { kind: 'group', id: 789 }, 1700000000000, null]);

  const failing = await buildEnvelope('group', group([seg('reply', { id: 8 })]), { resolveReply: async () => { throw new Error('x'); } });
  assert.deepEqual(failing.quote, { messageId: '8', text: '' }, '引用查不到只降级，不丢整条');
  assert.equal(failing.text, '[引用消息]');

  const priv = await buildEnvelope('private', { user_id: '0456', message: 'hi', sender: { nickname: '', card: '不该用' } });
  assert.deepEqual([priv.conv, priv.sender.qq, priv.sender.displayName, priv.quote], [{ kind: 'private', id: 456 }, 456, '456', undefined]);
  assert.deepEqual(parseSegments('text'), { at: [], quoteId: '' });
});

test('整句别名解析保留歧义，mentions 使用统一字符串 QQ', async () => {
  const env = await buildEnvelope('group', group([seg('text', { text: '@老王' })]), {
    resolveAlias: () => ({ ambiguous: true, qqs: ['222', '333'] }),
  });
  assert.deepEqual(env.mentions, [{ ambiguous: true, qqs: ['222', '333'], by: 'text:ambiguous' }]);
});

test('入口 accept 规范会话、解析 envelope 后按会话去重', async () => {
  const seen = [];
  const accept = createPipelineAccept({
    convKey: (kind, id) => `${kind}:${id}`,
    prepareIncoming: (kind, id, event) => {
      if (event.failPrecheck) throw new Error('temporary');
      return { key: `${kind}:${id}`, kind, id, flags: {}, decision: { gate: {} } };
    },
    identityDisplayName: () => null,
    resolveGroupMemberName: async () => null,
    resolveReplyInfo: async () => null,
    identityAliases: () => [],
    resolveIdentityAlias: () => null,
    resolveIdentityMentions: () => [],
    observeResolvedIdentity: () => {},
    observeAliasEvidence: () => {},
    processIncoming: (envelope) => seen.push(`${envelope.conv.kind}:${envelope.conv.id}:${envelope.id}`),
  }).acceptPipelineMessage;
  const event = { group_id: 789, user_id: 123, message_id: 42 };
  await accept('group', event, {});
  await accept('group', event, {});
  for (const message_id of [undefined, null, '']) {
    await assert.rejects(accept('group', { ...event, message_id, failPrecheck: true }, {}), /temporary/);
    await accept('group', event, {});
  }
  await accept('group', { ...event, group_id: 456 }, {});
  await accept('private', { user_id: 111 }, {});
  await accept('group', { ...event, group_id: 0, message_id: 43 }, {});
  assert.deepEqual(seen, ['group:789:42', 'group:456:42', 'private:111:']);
});

test('引用展开是历史读取，当前输入例外不能恢复受限作者正文', async () => {
  for (const restriction of ['context', 'deny', 'noContext', 'off']) {
    const cfg = { architecture: { gateV2: restriction !== 'off' } };
    let received;
    const b = {
      cfg, convKey: (kind, id) => `${kind}:${id}`,
      prepareIncoming: () => ({ flags: {}, decision: { gate: {} } }),
      gateDecide: () => ({ allowed: restriction !== 'deny', flags: { context: restriction !== 'context' } }),
      socialV2: { conversations: new Map([['group:789', { recentMessages: restriction === 'noContext' ? [{ userId: '222', messageId: '7', noContext: true }] : [], unread: [] }]]) },
      identityDisplayName: () => null, identityAliases: () => [], resolveIdentityAlias: () => null, resolveIdentityMentions: () => [],
      resolveReplyInfo: async () => ({ sender: '原作者', userId: '222', text: '不得恢复的历史正文' }),
      observeResolvedIdentity() {}, observeAliasEvidence() {}, processIncoming: envelope => { received = envelope; },
    };
    await createPipelineAccept(b).acceptPipelineMessage('group', group([seg('reply', { id: 7 }), seg('text', { text: '当前新问题' })]), cfg);
    assert.ok(received.text.includes('当前新问题'));
    assert.equal(received.text.includes('不得恢复的历史正文'), restriction === 'off', restriction);
  }
});

test('预检异常不会永久吞掉同一消息的重投', async () => {
  let attempts = 0;
  const accept = createPipelineAccept({
    convKey: (kind, id) => `${kind}:${id}`,
    prepareIncoming: () => { attempts++; if (attempts === 1) throw new Error('temporary'); return null; },
  }).acceptPipelineMessage;
  const event = { group_id: 789, user_id: 123, message_id: 42 };
  await assert.rejects(accept('group', event, {}), /temporary/);
  await accept('group', event, {});
  assert.equal(attempts, 2);
});

test('分发异常保留去重记录，重投不会重复执行已有副作用', async () => {
  const recorded = [];
  const accept = createPipelineAccept({
    convKey: (kind, id) => `${kind}:${id}`,
    prepareIncoming: () => ({ flags: {}, decision: { gate: {} } }),
    identityDisplayName: () => null,
    identityAliases: () => [],
    resolveIdentityAlias: () => null,
    resolveIdentityMentions: () => [],
    observeResolvedIdentity: () => {},
    observeAliasEvidence: () => {},
    processIncoming: (envelope) => {
      recorded.push(envelope.id);
      throw new Error('dispatch failed after recording');
    },
  }).acceptPipelineMessage;
  const event = { group_id: 789, user_id: 123, message_id: 42 };
  await assert.rejects(accept('group', event, {}), /dispatch failed/);
  await accept('group', event, {});
  assert.deepEqual(recorded, ['42']);
});

test('必填缺失的事件返回 null', async () => {
  for (const [kind, event] of [
    ['group', { user_id: 1, message: [] }], ['group', { group_id: 0, user_id: 1 }], ['group', { group_id: 5, user_id: 'abc' }],
    ['private', { message: [] }], ['guild', { group_id: 5, user_id: 1 }], ['group', null],
  ]) assert.equal(await buildEnvelope(kind, event), null, JSON.stringify(event));
});

test('去重：同会话同 id 只过一次，按会话隔离，超限淘汰最旧（命中刷新 LRU 顺序）', () => {
  const d = createDeduper({ max: 2 });
  assert.equal(d.seen('group:1', 42), false);
  assert.equal(d.seen('group:1', '42'), true);
  assert.equal(d.seen('group:2', 42), false, '不同会话互不影响');
  assert.equal(d.seen('group:1', ''), false);
  assert.equal(d.seen('group:1', null), false, '没有 id 的不去重');
  d.seen('group:1', 43);
  // 再次命中 42，刷新其最近使用顺序；插入 44 时应淘汰 43 而非 42
  assert.equal(d.seen('group:1', 42), true, '命中刷新 LRU 顺序');
  d.seen('group:1', 44);
  assert.equal(d.seen('group:1', 43), false, '未刷新的 43 应被淘汰');
  d.seen('group:1', 45);
  assert.equal(d.seen('group:1', 42), false, '此时最旧的 42 被淘汰');
  assert.equal(d.seen('group:1', 45), true);
});
