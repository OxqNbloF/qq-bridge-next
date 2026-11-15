import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTurnEngine } from '../src/scheduler/turn-engine.js';
import { createTimerRegistry } from '../src/scheduler/timer.js';
import { createSendGuard } from '../src/policy/send-guard.js';
import { createMemberPolicyStore } from '../src/store/member-policy.js';
import { createDshDeliver } from '../src/dsh/deliver.js';
import { evaluateTrigger } from '../src/scheduler/trigger.js';
import { bridgeHarness as createBridgeHarness } from './audit-bridge-harness.mjs';

// 排队/恢复测试不测试限频；限频另有独立用例，显式关闭以隔离该变量。
const bridgeHarness = (options = {}) => createBridgeHarness({ ...options, config: { ...options.config, socialV2: { ...options.config?.socialV2, wake: { maxWakePerMinute: 0, maxWakePerHour: 0, ...options.config?.socialV2?.wake } } } });

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let time = 1000;
  const timers = new Map();
  const now = () => time;
  const setTimeout = (run, ms) => { const handle = {}; timers.set(handle, { run, at: time + ms }); return handle; };
  const clearTimeout = (handle) => timers.delete(handle);
  async function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].run();
      await tick();
    }
    time = end;
    await tick();
  }
  return { now, setTimeout, clearTimeout, advance, timers };
}
const request = (seq, extra = {}) => ({ conv: 'group:456', mode: 'chat', trigger: { kind: 'message', strategy: 'immediate', seq, reason: 'message' }, payload: { promptText: String(seq) }, ...extra });
function fixture(options = {}) {
  const time = clock();
  const runs = [], events = [];
  const engine = createTurnEngine({ ...time, execute: async (req) => { runs.push(req); return { ok: true }; }, emit: (event) => events.push(event), ...options });
  return { engine, runs, events, time };
}

test('同会话等待回合结束，跨会话并行，全局并发受限', async () => {
  const { engine, runs } = fixture({ maxConcurrent: 2 });
  const first = engine.schedule(request(1));
  engine.schedule(request(2));
  engine.schedule(request(3, { conv: 'group:789' }));
  engine.schedule(request(4, { conv: 'private:123' }));
  await first.completion;
  assert.deepEqual(runs.map((req) => req.trigger.seq), [1, 3]);
  engine.bind('group:456', first.turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.settle('group:456', 's1', 't1');
  await tick();
  assert.deepEqual(runs.map((req) => req.trigger.seq), [1, 3, 2]);
  assert.equal(engine.stats('private:123').queueDepth, 1);
});

test('相同 TurnRequest 在排队/运行/结束后均不重复执行', async () => {
  const { engine, runs } = fixture();
  const first = engine.schedule(request(1));
  assert.equal(engine.schedule(request(1)).status, 'merged');
  await first.completion;
  engine.bind('group:456', first.turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.settle('group:456', 's1', 't1');
  assert.equal(engine.schedule(request(1)).status, 'dropped');
  assert.equal(runs.length, 1);
});

test('五字段幂等键忽略 reason，在排队/运行/完成后不重复投递', async () => {
  let ready = false;
  const { engine, runs } = fixture({ ready: () => ready });
  const first = engine.schedule(request(1));
  const renamed = request(1, { trigger: { ...request(1).trigger, reason: 'renamed' } });
  assert.equal(engine.schedule(renamed).status, 'merged');
  ready = true;
  await engine.replay();
  await first.completion;
  assert.equal(engine.schedule(renamed).status, 'merged');
  engine.finish('group:456', first.turnId);
  assert.equal(engine.schedule(renamed).status, 'dropped');
  assert.equal(runs.length, 1);
  for (const change of [{ kind: 'manual' }, { strategy: 'manual' }, { seq: 2 }]) {
    const next = engine.schedule(request(1, { trigger: { ...request(1).trigger, ...change } }));
    assert.notEqual(next.turnId, first.turnId);
  }
});

test('合批保留高优先级和最小 seq，定时请求不被消息合批吞掉', async () => {
  const { engine, runs, time } = fixture();
  engine.schedule(request(5, { windowMs: 100, batchKey: 'messages', priority: 1 }));
  engine.schedule(request(3, { windowMs: 100, batchKey: 'messages', priority: 90, payload: { wakeReason: 'atMention' } }));
  engine.schedule(request(9, { trigger: { kind: 'timer', strategy: 'timer', seq: 9, reason: 'timeout' }, priority: 10 }));
  assert.equal(runs.length, 0);
  await time.advance(100);
  assert.equal(runs[0].trigger.seq, 3);
  assert.equal(runs[0].payload.wakeReason, 'atMention');
  engine.bind('group:456', runs[0].turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.settle('group:456', 's1', 't1');
  await tick();
  assert.equal(runs[1].trigger.kind, 'timer');
});

for (const priority of [10, 90, 1]) {
  test(`合批无条件累计来源（后续优先级 ${priority}），保留 payload 选择和幂等语义`, async () => {
    const { engine, runs, time } = fixture();
    const originalPayload = { promptText: 'first', sourceQqs: [101, 102], opts: { silent: true, skipMemory: true } };
    const incomingPayload = { promptText: 'second', sourceQqs: [102, 103], opts: { silent: true, skipMemory: true }, wakeReason: 'atMention' };
    const firstRequest = request(5, { batchKey: 'messages', windowMs: 100, priority: 10, payload: originalPayload });
    const nextRequest = request(3, { batchKey: 'messages', windowMs: 100, priority, payload: incomingPayload,
      trigger: { ...request(3).trigger, reason: 'second' } });
    const first = engine.schedule(firstRequest);
    const merged = engine.schedule(nextRequest);
    assert.equal(merged.status, 'merged');
    assert.equal(merged.turnId, first.turnId);
    assert.equal(merged.completion, first.completion);
    const queued = engine.snapshot().conversations[0].queue[0].request;
    const selected = priority > 10 ? incomingPayload : originalPayload;
    assert.deepEqual(queued.payload, { ...selected, sourceQqs: [101, 102, 103] });
    assert.equal(queued.priority, Math.max(10, priority));
    assert.equal(queued.trigger.seq, 3);
    assert.equal(queued.trigger.reason, priority > 10 ? 'second' : 'message');
    // 已吸收的请求重放仍丢弃，不能改变来源或高优先级 payload。
    assert.equal(engine.schedule({ ...nextRequest, payload: { sourceQqs: [999] }, priority: 100 }).status, 'dropped');
    assert.deepEqual(engine.snapshot().conversations[0].queue[0].request, queued);
    assert.deepEqual(originalPayload.sourceQqs, [101, 102], '不能修改调用方原始 payload');
    assert.deepEqual(incomingPayload.sourceQqs, [102, 103]);
    await time.advance(100);
    await first.completion;
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].payload, queued.payload);
    engine.finish('group:456', first.turnId);
    assert.equal(engine.schedule(nextRequest).status, 'dropped');
  });
}

for (const priority of [10, 90]) {
  test(`合批来源在出队前改变成员策略后，真实 captureSendGuard 拒绝（后续优先级 ${priority}）`, async () => {
    const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
    const time = clock();
    const checks = [];
    const source = priority === 10 ? 102 : 101; // 同级会丢新来源，升级会丢旧来源。
    const engine = createTurnEngine({ ...time, execute: async req => {
      checks.push(guard.captureSendGuard(req.conv, { ai: true }));
      return { ok: true };
    } });
    // harness 只导出部分 app API；这里组合真实 store/guard，不覆写 VM 内 app。
    const b = { ...h, turnEngine: engine, log: () => {},
      isSessionAllowedInCurrentMode: () => true, readRoleState: () => ({ mode: 'normal' }) };
    const policy = createMemberPolicyStore(b);
    Object.assign(b, policy);
    const guard = createSendGuard(b);
    try {
      h.setMode('chat');
      const first = engine.schedule(request(5, { batchKey: 'messages', windowMs: 100, priority: 10, payload: { sourceQqs: [101] } }));
      engine.schedule(request(3, { batchKey: 'messages', windowMs: 100, priority, payload: { sourceQqs: [102] } }));
      assert.equal(policy.gateDecide({ kind: 'group', id: 456, qq: source }).flags.respond, true);
      fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { 'group:456': { mode: 'all', rules: {
        [source]: { flags: { respond: false, converse: true, context: true, memory: true } },
      } } } }));
      policy.loadMemberPolicy();
      await time.advance(100);
      await first.completion;
      assert.equal(checks.length, 1);
      assert.throws(checks[0], /成员策略不允许回应/);
      // 捕获后再改为硬拒绝，也必须在调用守卫时重算。
      h.cfg.ignore = { sendQQ: [String(source)] };
      assert.throws(checks[0], /成员策略不允许回应/);
    } finally { engine.cancel('group:456'); await h.close(); }
  });
}

test('DSH 唤醒投递将当前来源并入已有来源，不随 unread 淘汰而遗忘', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved2: true } } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    h.appendSocialV2Message(key, 'peer', 'hello', 'hello', false, false, 'source-102', [], 102);
    h.appendSocialV2Message(key, 'peer', 'new', 'new', false, false, 'source-103', [], 103);
    h.setReady(false);
    const scheduled = h.turnEngine.schedule(request(1, { mode: 'reserved2', payload: {
      wakeReason: 'atMention', sourceQqs: ['101', '102'], opts: {},
    } }));
    h.setReady(true);
    await h.turnEngine.replay();
    await scheduled.completion;
    assert.equal(h.calls.prompts.length, 1);
    assert.deepEqual(h.turnEngine.activeRequest(key).payload.sourceQqs, ['101', '102', '103']);
  } finally { await h.close(); }
});

test('旧离线投递队列保留 sourceQqs 供重放登记', async () => {
  const b = { isSessionAllowedInCurrentMode: () => true, dshReady: false, queued: new Map(), QUEUE_MAX: 50 };
  const deliver = createDshDeliver(b);
  await deliver.deliverPromptNow('group:456', 'offline', { sourceQqs: ['101', '102'] });
  assert.deepEqual(b.queued.get('group:456')[0].sourceQqs, ['101', '102']);
});

test('DSH prompt 发送前登记 opts、调度、二代与一代窗口来源', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } } } });
  try {
    h.setMode('chat');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    st.recentMessages.push({ userId: '103' });
    st.unread.push({ userId: '104' });
    h.social.recentMessages.set(key, [{ userId: '105' }]);
    const prompt = h.api.sessions.prompt;
    let sourcesAtSend;
    h.api.sessions.prompt = async input => {
      sourcesAtSend = [...(st.modelSourceQqs ?? [])];
      return prompt(input);
    };
    const scheduled = h.turnEngine.schedule(request(1, { payload: {
      promptText: 'sources', sourceQqs: ['102'], opts: { sourceQqs: ['101'] },
    } }));
    await scheduled.completion;
    assert.deepEqual(sourcesAtSend, ['101', '102', '103', '104', '105']);
  } finally { await h.close(); }
});

test('限频保留请求，到窗口后恢复；暂停只作用指定范围', async () => {
  const { engine, runs, time, events } = fixture();
  const first = engine.schedule(request(1, { rate: { perMinute: 1 } }));
  await first.completion;
  engine.bind('group:456', first.turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.settle('group:456', 's1', 't1');
  engine.schedule(request(2, { rate: { perMinute: 1 } }));
  await tick();
  assert.equal(engine.stats('group:456').queueDepth, 1);
  assert.ok(events.some((event) => event.reason === 'rate'));
  engine.pause('group:456');
  await time.advance(60000);
  assert.equal(runs.length, 1);
  engine.resume('group:456');
  await tick();
  assert.equal(runs.length, 2);
});

test('离线队列恢复前复查门禁，未放行请求不投递', async () => {
  let online = false, allow = true;
  const { engine, runs } = fixture({ ready: () => online, allowed: () => allow });
  assert.equal(engine.schedule(request(1)).status, 'stashed');
  allow = false;
  online = true;
  await engine.replay();
  assert.equal(runs.length, 0);
  assert.equal(engine.stats('group:456').queueDepth, 0);
});

test('只有明确未投递的请求退避重试，传输异常不自动重投', async () => {
  let attempts = 0;
  const { engine, time } = fixture({ execute: async () => ++attempts === 1 ? { retry: true } : { ok: true } });
  engine.schedule(request(1));
  await tick();
  await time.advance(2000);
  assert.equal(attempts, 2);
  const failed = fixture({ execute: async () => { throw new Error('unknown admission'); } });
  const result = failed.engine.schedule(request(2));
  assert.equal((await result.completion).ok, false);
  await failed.time.advance(60000);
  assert.equal(failed.engine.schedule(request(2)).status, 'dropped');
});

test('取消在途建会话后不能再绑定并发起投递；旧会话结束不释放新回合', async () => {
  const { engine } = fixture();
  const first = engine.schedule(request(1));
  await first.completion;
  engine.cancel('group:456');
  assert.equal(engine.bind('group:456', first.turnId, 'old'), false);
  const next = engine.schedule(request(2));
  await next.completion;
  engine.bind('group:456', next.turnId, 'new');
  engine.settle('group:456', 'old', 't1');
  assert.equal(engine.isBusy('group:456'), true);
});

test('snapshot 恢复在途回合不重发，两次重连后只执行尚未交付项', async () => {
  const source = fixture();
  const first = source.engine.schedule(request(1));
  await first.completion;
  source.engine.bind('group:456', first.turnId, 's1');
  source.engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  source.engine.schedule(request(2));
  const restored = fixture();
  restored.engine.restore(source.engine.snapshot());
  restored.engine.restore(restored.engine.snapshot());
  assert.equal(restored.runs.length, 0);
  restored.engine.settle('group:456', 's1', 't1');
  await tick();
  assert.deepEqual(restored.runs.map((req) => req.trigger.seq), [2]);
});

test('原地 restore 保留执行闭包、completion 与新请求，旧快照不复活完成项', async () => {
  let release;
  const runs = [];
  const { engine } = fixture({ execute: async req => {
    runs.push(req.trigger.seq);
    if (req.trigger.seq === 1) await new Promise(done => { release = done; });
    return { ok: true };
  } });
  const first = engine.schedule(request(1));
  const second = engine.schedule(request(2));
  const active = engine.activeRequest('group:456');
  const lease = engine.activeLease('group:456');
  const snapshot = engine.snapshot();
  const third = engine.schedule(request(3));
  engine.restore(snapshot);
  engine.restore(snapshot);
  assert.equal(engine.schedule(request(1)).completion, first.completion);
  assert.equal(engine.schedule(request(2)).completion, second.completion);
  assert.equal(engine.activeRequest('group:456'), active);
  assert.equal(engine.activeLease('group:456'), lease);
  assert.equal(engine.stats('group:456').queueDepth, 2);
  release();
  assert.equal((await first.completion).ok, true);
  engine.finish('group:456', first.turnId);
  await second.completion;
  engine.restore(snapshot);
  assert.equal(engine.schedule(request(1)).status, 'dropped');
  engine.finish('group:456', second.turnId);
  await third.completion;
  assert.deepEqual(runs, [1, 2, 3]);
});

test('恢复快照区分未交付/未知/已接纳，未知回合仅等快照不重投且 completion 可释放', async () => {
  let release;
  const { engine, time } = fixture({ leaseMs: 100, execute: async () => new Promise(done => { release = done; }) });
  const first = engine.schedule(request(1));
  engine.schedule(request(2));
  const snap = engine.snapshot();
  assert.equal(snap.conversations[0].active.delivery, 'unknown');
  assert.equal(snap.conversations[0].queue[0].delivery, 'undelivered');
  release({ ok: true });
  await first.completion;
  assert.equal(engine.snapshot().conversations[0].active.delivery, 'accepted');
  const restored = fixture({ leaseMs: 100 });
  restored.engine.restore(snap);
  const imported = restored.engine.schedule(request(1));
  let resolved = false;
  imported.completion.then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  assert.equal(restored.runs.length, 0);
  await restored.time.advance(100);
  assert.equal((await imported.completion).error, 'lease-expired');
  assert.equal(restored.runs.length, 1);
  await time.advance(100);
});

test('导入投递结果未知的 active 在完成快照证据到达后可结算，不等不存在的执行闭包', async () => {
  const source = fixture({ execute: async () => new Promise(() => {}) });
  const first = source.engine.schedule(request(1));
  source.engine.bind('group:456', first.turnId, 's1');
  const restored = fixture();
  restored.engine.restore(source.engine.snapshot());
  const imported = restored.engine.schedule(request(1));
  restored.engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 'recovered' } });
  restored.engine.settle('group:456', 's1', 'recovered');
  assert.equal(restored.engine.isBusy('group:456'), false);
  assert.equal((await imported.completion).ok, true);
  assert.equal(restored.runs.length, 0);
});

test('空引擎导入 settling 快照没有旧派发闭包，仍由原租约释放而非永久占位', async () => {
  const source = fixture({ leaseMs: 100 });
  const first = source.engine.schedule(request(1));
  await first.completion;
  source.engine.bind('group:456', first.turnId, 's1');
  source.engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  source.engine.event('group:456', 's1', { type: 'turn/end', data: { turn: 't1' } });
  const target = fixture({ leaseMs: 100 });
  target.engine.restore(source.engine.snapshot());
  const imported = target.engine.schedule(request(1));
  await target.time.advance(100);
  assert.equal(target.engine.isBusy('group:456'), false);
  assert.equal((await imported.completion).error, 'lease-expired');
});

test('租约记录会话和触发 kind；合批阶段保存在条目中，到期后离开 batching', async () => {
  const { engine, time } = fixture();
  const pending = engine.schedule(request(1, { trigger: { kind: 'replyCheck', strategy: 'batched', seq: 1, reason: 'replyCheck' }, windowMs: 100 }));
  assert.equal(engine.stats('group:456').state, 'batching');
  assert.equal(engine.snapshot().conversations[0].queue[0].phase, 'batching');
  await time.advance(100);
  await pending.completion;
  const lease = engine.activeLease('group:456');
  assert.equal(lease.conv, 'group:456');
  assert.equal(lease.kind, 'replyCheck');
  assert.equal(engine.stats('group:456').state, 'running');
});

test('租约过期释放调度占位并保留迟到回合的传输归属', async () => {
  const { engine, time, runs, events } = fixture({ leaseMs: 100 });
  const first = engine.schedule(request(1));
  await first.completion;
  engine.bind('group:456', first.turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.schedule(request(2));
  await time.advance(100);
  assert.equal(runs.length, 2);
  engine.bind('group:456', runs[1].turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't2' } });
  engine.settle('group:456', 's1', 't1');
  assert.equal(engine.isBusy('group:456'), true);
  assert.ok(events.some((event) => event.code === 'lease-expired'));
});

test('长定时器分段续期，可取消并按最终到期时间执行一次', async () => {
  const time = clock();
  const timers = createTimerRegistry(time);
  let calls = 0;
  timers.at('sleep', time.now() + 250000, () => calls++);
  assert.equal([...time.timers.values()][0].at - time.now(), 100009);
  await time.advance(249999);
  assert.equal(calls, 0);
  await time.advance(1);
  assert.equal(calls, 1);
  timers.at('sleep', time.now() + 1, () => calls++);
  timers.cancel('sleep');
  await time.advance(1);
  assert.equal(calls, 1);
});

test('Trigger 纯函数覆盖 @/引用/名字/整词/提问/成员/概率且优先级不变', () => {
  const base = { kind: 'group', event: { self_id: 999, user_id: 123 }, plainContent: 'hello', names: ['小鲸鱼'], directed: false, random: 0.5 };
  const check = (triggers, extra = {}) => evaluateTrigger({ ...base, triggers, ...extra });
  assert.equal(check({ atMention: true }, { event: { self_id: 999, message: [{ type: 'at', data: { qq: '999' } }] } }), 'atMention');
  assert.equal(check({ atMention: true }, { quoteTargetIsSelf: true }), 'atMention');
  assert.equal(check({ nameMention: true }, { plainContent: '小鲸鱼你好' }), 'nameMention');
  assert.equal(check({ keywords: ['DS'] }, { plainContent: 'ADS' }), null);
  assert.equal(check({ keywords: ['DS'] }, { plainContent: 'DS 在吗' }), 'keyword:DS');
  assert.equal(check({ question: true }, { directed: true }), 'question');
  assert.equal(check({ speakerIds: ['123'] }), 'speaker:123');
  assert.equal(check({ probability: 0.6 }), 'probability');
  assert.equal(check({ probability: 0.4 }), null);
  assert.equal(check({ anyMessage: true, atMention: true }), 'anyMessage');
  assert.equal(check({}, { kind: 'private' }), 'private');
});

for (const mode of ['chat', 'closed-agent', 'reserved', 'reserved2']) {
  test(`桥接 ${mode} 使用统一调度，旧开关默认关闭`, async () => {
    const h = await bridgeHarness({ config: { architecture: { schedulerV2: { [mode]: true } }, socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } } });
    try {
      h.setMode(mode);
      const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
      h.setReady(false);
      const first = await h.deliverPrompt(key, 'first');
      assert.equal(first.queued, true);
      assert.equal(h.calls.prompts.length, 0);
      h.setReady(true);
      await h.turnEngine.replay();
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(h.calls.prompts.length, 1);
      await h.deliverPrompt(key, 'second');
      assert.equal(h.calls.prompts.length, 1);
      const sid = h.state.sessions[key];
      h.scheduledTurnEvent(key, sid, { type: 'turn/start', data: { turn: 't1' } });
      h.settleScheduledTurn(key, sid, 't1');
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(h.calls.prompts.length, 2);
      assert.equal(h.cfg.architecture.schedulerV2.shadow, false);
    } finally { await h.close(); }
  });
}

test('影子调度不增加真实投递，V2 定时器状态不进入业务存储', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { shadow: true } } } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'one');
    assert.equal(h.calls.prompts.length, 1);
    assert.ok(h.shadowEvents.some((event) => event.type === 'turn:start'));
    h.cfg.architecture.schedulerV2.reserved2 = true;
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:789');
    assert.equal(Object.hasOwn(st, 'sleepTimer'), false);
    h.saveSocialV2State();
    assert.equal(Object.hasOwn(st, 'proactiveTimer'), false);
  } finally { await h.close(); }
});

test('二代真实唤醒走引擎，忙期定时请求在清空未读后仍会执行', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved2: true } }, socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    await h.sendWakePromptV2(key, 'bootstrap');
    await h.sendWakePromptV2(key, 'replyCheck');
    assert.equal(h.calls.prompts.length, 1);
    const sid = h.state.sessions[key];
    h.getSocialV2State(key).unread = [];
    h.scheduledTurnEvent(key, sid, { type: 'turn/start', data: { turn: 't1' } });
    h.settleScheduledTurn(key, sid, 't1');
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(h.calls.prompts.length, 2);
    assert.match(h.calls.prompts[1].content[0].text, /【回复检查】/);
    assert.equal(h.getSocialV2State(key).wakeTimes.length, 2);
  } finally { await h.close(); }
});

test('真实事件泵等发送收尾后才开始下一回合，重复 end 不重复发送', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } }, sendDelayMs: 0 } });
  let release;
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'first');
    await h.deliverPrompt('group:456', 'second');
    const sid = h.state.sessions['group:456'];
    const frames = ['turn/start', 'assistant/message', 'turn/end', 'turn/end'].map((type) => ({ payload: {
      type: 'session/event', sessionId: sid, event: { type, data: { turn: 't1',
        ...(type === 'assistant/message' ? { message: { content: [{ type: 'text', text: 'reply' }] } } : {}),
        ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}),
      } },
    } }));
    const gate = new Promise((done) => { release = done; });
    h.bot.sendGroupMessage = async (id, text) => { await gate; h.calls.sent.push({ id, text }); };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] } } }) };
    h.api.events.mux = async function* () {
      yield* frames;
      yield { payload: { type: 'session/snapshot', sessionId: sid, snapshot: { records: frames.slice(0, 3).map((frame, i) => ({ type: 'event', seq: i + 1, event: frame.payload.event })) } } };
      await new Promise(() => {});
    };
    void h.pumpMux();
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.turnEngine.stats('group:456').state, 'settling');
    release();
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.sent.length, 1);
  } finally { release?.(); await h.close(); }
});

test('真实重连快照重复两次只补发一次，已交付 prompt 不重新提交', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } }, sendDelayMs: 0 } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'first');
    await h.deliverPrompt('group:456', 'second');
    const sid = h.state.sessions['group:456'];
    h.scheduledTurnEvent('group:456', sid, { type: 'turn/start', data: { turn: 't1' } });
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 1, data: { turn: 't1' } });
    h.collectors.clear();
    const snapshot = { records: [
      { type: 'event', seq: 1, event: { type: 'turn/start', data: { turn: 't1' } } },
      { type: 'event', seq: 2, event: { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text: 'reply' }] } } } },
      { type: 'event', seq: 3, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } },
    ] };
    await h.handleSessionSnapshot(sid, snapshot);
    await tick();
    await h.handleSessionSnapshot(sid, snapshot);
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.sent.length, 1);
  } finally { await h.close(); }
});

for (const lostCall of [false, true]) test(`真实断线原地恢复保留 collector/工具与 completion，重复快照后只补未交付请求（call 丢失=${lostCall}）`, async () => {
  const { createAsyncHelpers } = await import('../src/infra/async.js');
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true, maxConcurrent: 1 } }, sendDelayMs: 0 },
    globals: { createAsyncHelpers: options => ({ ...createAsyncHelpers(options), sleep: async () => {} }) } });
  try {
    h.setMode('chat');
    const first = h.turnEngine.schedule(request(1));
    await first.completion;
    const second = h.turnEngine.schedule(request(2));
    const sid = h.state.sessions['group:456'];
    const live = (type, data, seq) => ({ payload: { type: 'session/event', sessionId: sid, event: { type, data, seq } } });
    const start = live('turn/start', { turn: 'tool-turn' }, 1);
    const call = live('tool/call', { callId: 'send-1', name: 'mcp__snowluma__qq_send_message', arguments: {} }, 2);
    const records = [start, call].map(frame => ({ type: 'event', seq: frame.payload.event.seq, event: frame.payload.event }));
    let streams = 0, collector, snapshots = 0, restores = 0;
    const snapshot = h.turnEngine.snapshot, restore = h.turnEngine.restore;
    h.turnEngine.snapshot = (...args) => { snapshots++; return snapshot(...args); };
    h.turnEngine.restore = (...args) => { restores++; return restore(...args); };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'qq-chat' }, { id: 'standard', isDefault: true }] } } }) };
    let recovered;
    const done = new Promise(resolve => { recovered = resolve; });
    h.api.events.mux = async function* () {
      if (++streams === 1) {
        yield start;
        if (!lostCall) yield call;
        collector = h.collectors.get(sid);
        return;
      }
      try {
        assert.equal(h.collectors.get(sid), collector, '断线不能清除 collector');
        assert.equal(h.turnEngine.schedule(request(2)).completion, second.completion);
        for (let i = 0; i < 2; i++) yield { payload: { type: 'session/snapshot', sessionId: sid, snapshot: { records } } };
        assert.equal(h.collectors.get(sid), collector, '重复快照不能替换 collector');
        assert.equal(h.turnEngine.activeLease('group:456').transportTurn, 'tool-turn');
        if (streams === 2) return; // 在途工具跨第二次真实断线继续恢复。
        yield start; // follow 也可能重放快照已包含的 start，不得清掉工具回执。
        yield live('tool/result', { message: { source: { callId: 'send-1' }, content: [{ type: 'text', text: 'sent' }] } }, 3);
        yield live('assistant/message', { turn: 'tool-turn', message: { content: [{ type: 'text', text: 'do not forward' }] } }, 4);
        yield live('turn/end', { turn: 'tool-turn', reason: { kind: 'completed' } }, 5);
        recovered();
      } catch (error) { recovered(error); }
      await new Promise(() => {});
    };
    void h.pumpMux();
    assert.ifError(await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect timeout')), 500))]));
    await second.completion;
    assert.ok(snapshots >= 2, '两次真实断线均须保存引擎快照');
    assert.ok(restores >= 2, '两次真实重连均须原地恢复引擎快照');
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.sent.length, 0, '发送工具成功后不自动重复发文本');
  } finally { await h.close(); }
});

test('在途快照补齐断线文本但不替换 collector，完成快照清除旧占位后放行', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } }, sendDelayMs: 0 } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'first');
    const sid = h.state.sessions['group:456'];
    const event = (type, seq, data) => ({ type, seq, data: { turn: 'partial', ...data } });
    const start = event('turn/start', 1);
    const a = event('assistant/message', 2, { message: { content: [{ type: 'text', text: 'A' }] } });
    const b = event('assistant/message', 3, { message: { content: [{ type: 'text', text: 'B' }] } });
    h.scheduledTurnEvent('group:456', sid, start);
    h.trackTurnEvent(sid, start); h.trackTurnEvent(sid, a);
    const collector = h.collectors.get(sid);
    const records = [start, a, b].map(event => ({ type: 'event', seq: event.seq, event }));
    await h.handleSessionSnapshot(sid, { records });
    await h.handleSessionSnapshot(sid, { records });
    assert.equal(h.collectors.get(sid), collector);
    h.trackTurnEvent(sid, b); // 快照后的 live 重放同一 seq 不能重复累加。
    assert.equal(h.trackTurnEvent(sid, event('turn/end', 4, { reason: { kind: 'completed' } })).ended.text, 'AB');
    h.settleScheduledTurn('group:456', sid, 'partial');
    await h.handleSessionSnapshot(sid, { records }); // 迟到的旧在途快照不能复活已交付回合。
    assert.equal(h.collectors.has(sid), false);
    await h.deliverPrompt('group:456', 'second');
    const next = event('turn/start', 5, { turn: 'snapshot-ended' });
    h.scheduledTurnEvent('group:456', sid, next); h.trackTurnEvent(sid, next);
    const queued = h.turnEngine.schedule(request(99));
    await h.handleSessionSnapshot(sid, { records: [next, event('turn/end', 6, { turn: 'snapshot-ended', reason: { kind: 'completed' } })].map(event => ({ type: 'event', seq: event.seq, event })) });
    await queued.completion;
    assert.equal(h.calls.prompts.length, 3);
  } finally { await h.close(); }
});

test('静默在途摘要完成快照只结算不外发，重连不丢失静默名额', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } }, sendDelayMs: 0 } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'private summary', { silent: true });
    const sid = h.state.sessions['group:456'];
    await h.handleSessionSnapshot(sid, { records: [
      { type: 'event', seq: 1, event: { type: 'turn/start', data: { turn: 'silent' } } },
      { type: 'event', seq: 2, event: { type: 'assistant/message', data: { turn: 'silent', message: { content: [{ type: 'text', text: 'private response' }] } } } },
      { type: 'event', seq: 3, event: { type: 'turn/end', data: { turn: 'silent', reason: { kind: 'completed' } } } },
    ] });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.social.silentTurns.has(sid), false);
    assert.equal(h.turnEngine.isBusy('group:456'), false);
  } finally { await h.close(); }
});

test('真实重连 start 丢失且 prompt ACK 在途，新消息与重复快照交错不悬挂 completion', async () => {
  const { createAsyncHelpers } = await import('../src/infra/async.js');
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true, maxConcurrent: 1 } }, sendDelayMs: 0 },
    globals: { createAsyncHelpers: options => ({ ...createAsyncHelpers(options), sleep: async () => {} }) } });
  let release;
  try {
    h.setMode('chat');
    const ack = new Promise(resolve => { release = resolve; });
    const prompt = h.api.sessions.prompt;
    h.api.sessions.prompt = async input => { const result = await prompt(input); await ack; return result; };
    const first = h.turnEngine.schedule(request(1));
    while (!h.calls.prompts.length) await new Promise(resolve => setImmediate(resolve));
    const second = h.turnEngine.schedule(request(2));
    const sid = h.state.sessions['group:456'];
    const active = h.turnEngine.activeRequest('group:456');
    const snapshot = { records: [
      { type: 'event', seq: 1, event: { type: 'turn/start', data: { turn: 'missing-start' } } },
      { type: 'event', seq: 2, event: { type: 'assistant/message', data: { turn: 'missing-start', message: { content: [{ type: 'text', text: 'recovered once' }] } } } },
      { type: 'event', seq: 3, event: { type: 'turn/end', data: { turn: 'missing-start', reason: { kind: 'completed' } } } },
    ] };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'qq-chat' }, { id: 'standard', isDefault: true }] } } }) };
    let streams = 0, third, recovered;
    const done = new Promise(resolve => { recovered = resolve; });
    h.api.events.mux = async function* () {
      if (++streams === 1) return;
      third = h.turnEngine.schedule(request(3));
      yield { payload: { type: 'session/snapshot', sessionId: sid, snapshot } };
      yield { payload: { type: 'session/snapshot', sessionId: sid, snapshot } };
      recovered();
      await new Promise(() => {});
    };
    void h.pumpMux();
    await done;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.turnEngine.activeRequest('group:456'), active);
    assert.equal(h.turnEngine.schedule(request(1)).completion, first.completion);
    assert.equal(h.turnEngine.schedule(request(2)).completion, second.completion);
    assert.equal(h.calls.prompts.length, 1);
    assert.deepEqual(h.calls.sent.map(item => item.text), ['recovered once']);
    release();
    assert.equal((await first.completion).ok, true);
    await second.completion;
    assert.equal(h.calls.prompts.length, 2);
    h.turnEngine.finish('group:456', second.turnId);
    await third.completion;
    assert.equal(h.calls.prompts.length, 3);
  } finally { release?.(); await h.close(); }
});

test('替换具名定时器后，取消旧句柄不会取消新定时器', async () => {
  const time = clock();
  const timers = createTimerRegistry(time);
  const calls = [];
  const previous = timers.at('sleep', time.now() + 10, () => calls.push('old'));
  timers.at('sleep', time.now() + 20, () => calls.push('new'));
  previous.cancel();
  await time.advance(20);
  assert.deepEqual(calls, ['new']);
});

test('一代延迟回复由引擎计时，可取消且不写旧 pendingTimers', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved: true } } } });
  try {
    h.setMode('reserved');
    h.scheduleSocialReply('group:456', 'cancelled', 30, 30, 'fixture');
    assert.equal(h.social.pendingTimers.size, 0);
    assert.equal(h.turnEngine.stats('group:456').queueDepth, 1);
    h.cancelSocialTimers('group:456');
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(h.calls.prompts.length, 0);
    h.scheduleSocialReply('group:456', 'delayed', 10, 10, 'fixture');
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /delayed$/);
  } finally { await h.close(); }
});

test('二代有限睡眠归统一 timer，清理后不会留下到期唤醒', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved2: true } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 40).toISOString();
    h.setupSleepTimerV2('group:456');
    const runtime = h.schedulerRuntime('group:456', st);
    assert.equal(typeof runtime.sleepTimer.cancel, 'function');
    assert.equal(Object.hasOwn(st, 'sleepTimer'), false);
    h.clearSocialV2Timers('group:456');
    await new Promise((done) => setTimeout(done, 60));
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(runtime.sleepTimer, null);
  } finally { await h.close(); }
});

test('排队的静默摘要不会提前占用上一正常回合的静默标记', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved: true } } } });
  try {
    h.setMode('reserved');
    await h.deliverPrompt('group:456', 'normal');
    const sid = h.state.sessions['group:456'];
    await h.deliverPrompt('group:456', 'private summary', { silent: true });
    assert.equal(h.social.silentTurns.has(sid), false);
    h.scheduledTurnEvent('group:456', sid, { type: 'turn/start', data: { turn: 'normal-turn' } });
    h.settleScheduledTurn('group:456', sid, 'normal-turn');
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.social.silentTurns.get(sid).length, 1);
    assert.equal(h.social.silentTurns.get(sid)[0].ts <= Date.now(), true);
  } finally { await h.close(); }
});

test('普通唤醒在离线排队后变为已读则跳过，定向唤醒保留', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved2: true } } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', 'peer', 'hi', 'hi', false, false, 'incoming-1');
    h.setReady(false);
    await h.sendWakePromptV2('group:456', 'anyMessage');
    h.getSocialV2State('group:456').unread = [];
    h.setReady(true);
    await h.turnEngine.replay();
    assert.equal(h.calls.prompts.length, 0);
    // 换 reason 不是新回合；同 kind/seq/strategy 已由五字段幂等键关闭。
    h.appendSocialV2Message('group:456', 'peer', 'directed', 'directed', false, false, 'incoming-2');
    await h.sendWakePromptV2('group:456', 'atMention');
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

test('错误或中断回合按实际 outcome 释放，不上报正常完成', async () => {
  const { engine, events } = fixture();
  const first = engine.schedule(request(1));
  await first.completion;
  engine.bind('group:456', first.turnId, 's1');
  engine.event('group:456', 's1', { type: 'turn/start', data: { turn: 't1' } });
  engine.settle('group:456', 's1', 't1', 'aborted');
  assert.equal(engine.isBusy('group:456'), false);
  assert.ok(events.some((event) => event.type === 'turn:error' && event.code === 'aborted'));
  assert.equal(events.some((event) => event.type === 'turn:end'), false);
});

test('已接纳但 start 帧丢失：完成快照补发一次并继续排队请求', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true } }, sendDelayMs: 0 } });
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'first');
    await h.deliverPrompt('group:456', 'second');
    const sid = h.state.sessions['group:456'];
    const snapshot = { records: [
      { type: 'event', seq: 1, event: { type: 'turn/start', data: { turn: 'missed-start' } } },
      { type: 'event', seq: 2, event: { type: 'assistant/message', data: { turn: 'missed-start', message: { content: [{ type: 'text', text: 'recovered' }] } } } },
      { type: 'event', seq: 3, event: { type: 'turn/end', data: { turn: 'missed-start', reason: { kind: 'completed' } } } },
    ] };
    await h.handleSessionSnapshot(sid, snapshot);
    await tick();
    await h.handleSessionSnapshot(sid, snapshot);
    assert.equal(h.calls.sent.length, 1);
    assert.equal(h.calls.sent[0].text, 'recovered');
    assert.equal(h.calls.prompts.length, 2);
  } finally { await h.close(); }
});

test('离开二代模式后仍清理原 runtime，返回时能重新安排定时器', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { reserved2: true } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 200).toISOString();
    h.setupSleepTimerV2('group:456');
    const runtime = h.schedulerRuntime('group:456', st);
    const previous = runtime.sleepTimer;
    h.setMode('chat');
    h.clearSocialV2Timers('group:456');
    assert.equal(runtime.sleepTimer, null);
    h.setMode('reserved2');
    h.setupSleepTimerV2('group:456');
    assert.ok(runtime.sleepTimer);
    assert.notEqual(runtime.sleepTimer, previous);
    h.clearSocialV2Timers('group:456');
  } finally { await h.close(); }
});

for (const mode of ['chat', 'closed-agent', 'reserved', 'reserved2']) {
  test(`新引擎 ${mode} 在 start 帧缺失时仍可恢复卡死并释放租约`, async () => {
    const h = await bridgeHarness({ config: { architecture: { schedulerV2: { [mode]: true } }, turnStallMs: 10 } });
    try {
      h.setMode(mode);
      const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
      await h.deliverPrompt(key, 'stalled');
      const sid = h.state.sessions[key];
      assert.equal(h.turnEngine.isBusy(key), true);
      assert.deepEqual(h.checkStalledTurns(Date.now() + 100), [sid]);
      await tick();
      assert.deepEqual(h.calls.cancelled, [sid]);
      assert.equal(h.turnEngine.isBusy(key), false);
    } finally { await h.close(); }
  });
}

test('重连恢复的在途 collector 也占用全局并发名额', async () => {
  const h = await bridgeHarness({ config: { architecture: { schedulerV2: { chat: true, maxConcurrent: 1 } }, allow: { private: ['123'], groups: ['456', '789'] } } });
  try {
    h.setMode('chat');
    const sid = await h.ensureSession('group:456');
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 1, data: { turn: 'restored' } });
    h.v2TurnStartAt.set(sid, Date.now());
    const result = await h.deliverPrompt('group:789', 'wait for recovered work');
    assert.equal(result.queued, true);
    assert.equal(h.calls.prompts.length, 0);
    h.trackTurnEvent(sid, { type: 'turn/end', seq: 2, data: { turn: 'restored', reason: { kind: 'completed' } } });
    await h.turnEngine.replay();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

test('出站积压丢弃已结束回合时仍释放 settling，不阻塞下一次投递', async () => {
  const h = await bridgeHarness({ config: { modes: { engine: { chat: true } }, sendDelayMs: 0 } });
  let release;
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', 'first');
    const sid = h.state.sessions['group:456'];
    const gate = new Promise((done) => { release = done; });
    h.dispatchSessionTask(sid, false, () => gate);
    const frames = ['turn/start', 'assistant/message', 'turn/end'].map((type) => ({ payload: { type: 'session/event', sessionId: sid, event: { type, data: { turn: 't1',
      ...(type === 'assistant/message' ? { message: { content: [{ type: 'text', text: 'dropped' }] } } : {}),
      ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}),
    } } } }));
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'qq-chat' }, { id: 'standard', isDefault: true }] } } }) };
    h.api.events.mux = async function* () { yield* frames; await new Promise(() => {}); };
    void h.pumpMux();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(h.turnEngine.stats('group:456').state, 'settling');
    for (let i = 0; i < 21; i++) h.dispatchSessionTask(sid, true, async () => {});
    assert.ok(h.dispatchStats.dropped > 0);
    assert.equal(h.turnEngine.stats('group:456').state, 'idle');
    await h.deliverPrompt('group:456', 'next');
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.sent.length, 0);
  } finally { release?.(); await h.close(); }
});

test('模式未知时的完成快照在模式确定后解除等待，补发失败也不永久卡队列', async () => {
  const sid = 'qqb-g-456';
  const h = await bridgeHarness({ config: { modes: { engine: { chat: true } }, sendDelayMs: 0 }, savedState: {
    sessions: { 'group:456': sid }, sessionPolicies: { 'group:456': JSON.stringify(['chat', 'qq-chat', null]) },
  } });
  try {
    h.trackTurnEvent(sid, { type: 'turn/start', seq: 1, data: { turn: 't1' } });
    h.bot.sendGroupMessage = async () => { throw new Error('fixture send failed'); };
    await h.handleSessionSnapshot(sid, { records: [
      { type: 'event', seq: 1, event: { type: 'turn/start', data: { turn: 't1' } } },
      { type: 'event', seq: 2, event: { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text: 'reply' }] } } } },
      { type: 'event', seq: 3, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } },
    ] });
    h.setMode('chat');
    assert.equal((await h.deliverPrompt('group:456', 'next')).queued, true);
    h.collectors.clear();
    await h.replayDeferredDeliveries();
    await tick();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.deliveryCursors.get(sid).deliveredSeq, -1, '发送失败保留交付游标');
  } finally { await h.close(); }
});

test('执行边界保留 trigger 原因语义，普通 prompt 是 message 而非 manual', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  let mode = 'chat';
  const scheduler = createSchedulerExecutor({ ...clock(), cfg: { modes: { engine: { chat: true, reserved2: true } } },
    state: { sessions: {} }, collectors: new Map(), reverse: new Map(), v2TurnStartAt: new Map(),
    pendingWakeKeys: new Set(), socialV2: { paused: false }, dshReady: false,
    modeForKey: () => mode, isSessionAllowedInCurrentMode: () => true, log: () => {},
    getSocialV2State: () => ({ lastUnreadSeq: 4, unread: [{ seq: 4 }] }),
  });
  try {
    await scheduler.schedulePrompt('group:456', 'normal');
    assert.equal(scheduler.turnEngine.snapshot().conversations[0].queue[0].request.trigger.kind, 'message');
    scheduler.cancelAllScheduledTurns('next'); mode = 'reserved2';
    for (const [reason, kind, strategy] of [
      ['replyCheck', 'replyCheck', 'timer'], ['proactiveCheck', 'proactive', 'timer'],
      ['bootstrap', 'bootstrap', 'timer'], ['timeout', 'timer', 'timer'],
      ['admin', 'manual', 'manual'], ['atMention', 'message', 'immediate'],
    ]) {
      await scheduler.scheduleWakeTurn('group:456', reason);
      const trigger = scheduler.turnEngine.snapshot().conversations[0].queue[0].request.trigger;
      assert.equal(trigger.kind, kind, reason);
      assert.equal(trigger.strategy, strategy, reason);
      scheduler.cancelAllScheduledTurns('next');
    }
  } finally { scheduler.cancelAllScheduledTurns('test-complete'); }
});

test('二代唤醒入口透传模式决策，strategy 不由窗口长度覆盖', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const { createSchedulerV2 } = await import('../src/features/social-v2/scheduler.js');
  const st = { lastUnreadSeq: 4, unread: [{ seq: 4 }], wakeConfig: { batchWindowMs: 1000 } };
  const b = { ...clock(), cfg: { modes: { engine: { reserved2: true } } }, state: { sessions: {} },
    collectors: new Map(), reverse: new Map(), v2TurnStartAt: new Map(), pendingWakeKeys: new Set(),
    socialV2: { paused: false, conversations: new Map([['group:456', st]]) }, dshReady: false,
    modeForKey: () => 'reserved2', isSessionAllowedInCurrentMode: () => true, log: () => {}, getSocialV2State: () => st,
  };
  Object.assign(b, createSchedulerExecutor(b), createSchedulerV2(b));
  try {
    b.scheduleWakeV2('group:456', 'atMention', { action: 'wake', strategy: 'immediate', reason: 'atMention', priority: 91 });
    const queued = b.turnEngine.snapshot().conversations[0].queue[0].request;
    assert.equal(queued.trigger.kind, 'message');
    assert.equal(queued.trigger.strategy, 'immediate');
    assert.equal(queued.priority, 91);
  } finally { b.cancelAllScheduledTurns('test-complete'); }
});

for (const mode of ['chat', 'closed-agent', 'reserved']) test(`统一调度 ${mode} 复用既有限频参数，超限保留队列`, async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const runs = [];
  const scheduler = createSchedulerExecutor({ ...clock(), cfg: { modes: { engine: { [mode]: true } }, socialV2: { wake: { maxWakePerMinute: 1, maxWakePerHour: 3 } } },
    state: { sessions: {} }, collectors: new Map(), reverse: new Map(), v2TurnStartAt: new Map(),
    pendingWakeKeys: new Set(), dshReady: true, modeForKey: () => mode,
    isSessionAllowedInCurrentMode: () => true, log: () => {},
    deliverPromptNow: async req => { runs.push(req); return { ok: true }; },
  });
  const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
  try {
    const first = await scheduler.schedulePrompt(key, 'first');
    scheduler.turnEngine.finish(key, first.turnId);
    const second = await scheduler.schedulePrompt(key, 'second');
    assert.equal(second.queued, true);
    assert.equal(runs.length, 1);
    const queued = scheduler.turnEngine.snapshot().conversations[0].queue[0].request;
    assert.deepEqual(queued.rate, { perMinute: 1, perHour: 3 });
  } finally { scheduler.cancelAllScheduledTurns('test-complete'); }
});

test('未收到任何快照时，等待在租约到期后自动放行', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const runs = [];
  const b = { cfg: { modes: { engine: { chat: true } } }, state: { sessions: { 'group:456': 's1' } },
    collectors: new Map(), reverse: new Map([['s1', 'group:456']]), v2TurnStartAt: new Map(), pendingWakeKeys: new Set(),
    dshReady: true, TURN_BUSY_LEASE_MS: 10, setTimeout, clearTimeout, log: () => {}, disarmPendingWakeLease: () => {},
    modeForKey: () => 'chat', isSessionAllowedInCurrentMode: () => true,
    deliverPromptNow: async (...args) => { runs.push(args); return { ok: true }; },
  };
  const scheduler = createSchedulerExecutor(b);
  try {
    assert.equal((await scheduler.schedulePrompt('group:456', 'next')).queued, true);
    assert.equal(runs.length, 0);
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(runs.length, 1);
  } finally { scheduler.cancelAllScheduledTurns('test-complete'); }
});

test('N-08：turnEngine 在 tool/call 未收到 tool/result 时于首个租约到期顺延一次', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const c = clock();
  const runs = [];
  let scheduler;
  const b = { ...c, cfg: { modes: { engine: { reserved2: true } } }, TURN_BUSY_LEASE_MS: 100,
    state: { sessions: {} }, collectors: new Map(), reverse: new Map(),
    v2TurnStartAt: new Map(), pendingWakeKeys: new Set(), dshReady: true, log: () => {}, disarmPendingWakeLease: () => {},
    modeForKey: () => 'reserved2', isSessionAllowedInCurrentMode: () => true,
    deliverPromptNow: async (key, promptText, opts) => {
      b.state.sessions[key] = 's1';
      b.reverse.set('s1', key);
      scheduler.turnEngine.bind(key, opts.schedulerTurnId, 's1');
      runs.push(promptText);
      return { ok: true };
    },
  };
  scheduler = createSchedulerExecutor(b);
  try {
    await scheduler.schedulePrompt('group:456', 'first');
    assert.equal(runs.length, 1);
    await scheduler.schedulePrompt('group:456', 'second');
    await c.advance(60);
    scheduler.scheduledTurnEvent('group:456', 's1', { type: 'tool/call', data: { callId: 'c1', name: 'qq_wait_for_messages' } });
    // 到初始 100ms 时因在途工具顺延，不提前判租约超时放行 second
    await c.advance(50);
    assert.equal(runs.length, 1, '在途工具调用应在首个租约到期时顺延');
    assert.equal(scheduler.turnEngine.activeLease('group:456')?.pendingToolCalls?.includes('c1'), true);
    // 顺延窗口到期仍未结束则最终超时放行
    await c.advance(60);
    assert.equal(runs.length, 2, '顺延租约到期后释放并执行下一条');
  } finally { scheduler.cancelAllScheduledTurns('test-complete'); }
});

test('R-02：无 seq 的非 chunk 直播帧在重复投递与快照重合时不重复追加正文', async () => {
  const { createDshEvents } = await import('../src/dsh/events.js');
  const sent = [];
  const collectors = new Map();
  const mockB = {
    collectors,
    reverse: new Map([['s1', 'group:456']]),
    state: { sessions: { 'group:456': 's1' } },
    log: () => {},
    markTurnStarted: () => {},
    markTurnDelivered: () => {},
    isCurrentSession: () => true,
    deliveryCursors: new Map(),
    social: { silentTurns: new Map(), exitingSessions: new Set(), activeDeadlines: new Map() },
    cfg: {},
    TURN_BUSY_LEASE_MS: 60_000,
    RESTORED_TURN_GRACE_MS: 10_000,
    learnerSessions: new Set(),
    learnerCollectors: new Map(),
    learnerWaiters: new Map(),
    pending: new Map(),
    sendToQQ: (_k, text) => sent.push(text),
    shouldAuditKey: () => false,
    modeForKey: () => 'chat',
    sanitizeToolArgs: x => x,
    appendToolLog: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const { trackTurnEvent, rebuildInFlightCollector } = createDshEvents(mockB);
  const msg = { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text: '同一句' }] } } };
  // 无 seq 快照恢复后，又收到同一条无 seq 直播 assistant/message，只收一次
  rebuildInFlightCollector('s1', [
    { type: 'event', event: { type: 'turn/start', data: { turn: 't1' } } },
    { type: 'event', event: msg },
  ]);
  trackTurnEvent('s1', msg);
  trackTurnEvent('s1', msg);
  const chunk = { type: 'assistant/chunk', data: { turn: 't1', delta: 'ok' } };
  // assistant/chunk 在直播路径不误去重（仅非 chunk 结构去重）
  assert.equal(trackTurnEvent('s1', chunk).ended, null);
  assert.equal(trackTurnEvent('s1', chunk).ended, null);
  const done = trackTurnEvent('s1', { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } });
  assert.equal(done.ended.text, '同一句', '无 seq 重复 assistant/message 不得双倍叠加');
  void sent;
});

test('R-03：执行器 available 与 externalRunning 联动工具豁免窗口，不提前并行启动第二回合', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const h = await bridgeHarness({ config: { modes: { engine: false } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const sid = 'ext-busy-sid';
    h.state.sessions[key] = sid;
    h.reverse.set(sid, key);
    h.collectors.set(sid, { push: () => null, size: () => 1 });
    // 起始超过 TURN_BUSY_LEASE_MS，但最近有未返回的 tool/call
    h.v2TurnStartAt.set(sid, Date.now() - h.TURN_BUSY_LEASE_MS - 10_000);
    h.toolCallNames.set(sid, new Map([['c1', 'qq_wait_for_messages']]));
    h.toolCallAt.set(sid, Date.now() - 1000);

    assert.equal(h.isSessionTurnBusy(sid), true, '在途工具调用在 2x 租约期内应维持忙');
    assert.equal(h.isConversationBusyV2(key, h.getSocialV2State(key)), true);

    const runs = [];
    const exec = createSchedulerExecutor({
      cfg: { modes: { engine: { reserved2: true } }, architecture: { schedulerV2: { maxConcurrent: 1 } } },
      state: { sessions: { [key]: sid } },
      collectors: h.collectors,
      reverse: h.reverse,
      v2TurnStartAt: h.v2TurnStartAt,
      isSessionTurnBusy: h.isSessionTurnBusy,
      pendingWakeKeys: new Set(),
      dshReady: true,
      TURN_BUSY_LEASE_MS: h.TURN_BUSY_LEASE_MS,
      setTimeout, clearTimeout,
      log: () => {},
      disarmPendingWakeLease: () => {},
      modeForKey: () => 'reserved2',
      isSessionAllowedInCurrentMode: () => true,
      deliverPromptNow: async req => { runs.push(req); return { ok: true }; },
    });
    const scheduled = await exec.schedulePrompt(key, 'next-while-tool-busy');
    assert.equal(scheduled.queued, true);
    assert.equal(runs.length, 0, '外部长工具占用期间执行器不得抢发第二回合');

    // 工具完成后释放
    h.toolCallNames.get(sid).clear();
    assert.equal(h.isSessionTurnBusy(sid), false);
    exec.cancelAllScheduledTurns('test-complete');
  } finally { await h.close(); }
});

test('R-08：挂起撤权与学习会话自动跳过对瞬时失败重试，全败时使学习会话失效', async () => {
  const { createPendingQuestions } = await import('../src/conversations/pending.js');
  const { createDshEvents } = await import('../src/dsh/events.js');
  let pendingAttempts = 0;
  const pq = createPendingQuestions({
    pending: new Map(),
    api: { respond: async () => { pendingAttempts++; if (pendingAttempts === 1) throw new Error('temp'); return { ok: true }; } },
    withTimeout: p => p,
    log: () => {},
    setTimeout, clearTimeout,
  });
  await pq.cancelPendingEntry({ kind: 'approval', clientId: 'c1', eventId: 'e1' });
  assert.equal(pendingAttempts, 2, 'cancelPendingEntry 瞬时失败应重试一次并成功');

  let learnerRespondCount = 0;
  let invalidated = false;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const mockB = {
    collectors: new Map(),
    reverse: new Map(),
    state: { sessions: {} },
    activeWaits: new Map(),
    log: () => {},
    isCurrentSession: () => true,
    deliveryCursors: new Map(),
    social: { silentTurns: new Map(), exitingSessions: new Set() },
    cfg: {},
    TURN_BUSY_LEASE_MS: 60_000,
    RESTORED_TURN_GRACE_MS: 10_000,
    DSH_CONTROL_TIMEOUT_MS: 5000,
    refreshMode: async () => {},
    refreshPresetList: async () => {},
    reconcileSessionPolicies: () => {},
    learnerSessions: new Set(['learn-s1']),
    learnerCollectors: new Map(),
    learnerWaiters: new Map(),
    pending: new Map(),
    shutdownRequested: false,
    api: {
      respond: async () => { learnerRespondCount++; throw new Error('respond down'); },
      events: {
        mux: async function* () {
          yield { payload: { type: 'approval/requested', sessionId: 'learn-s1', clientId: 'c1', eventId: 'ev1' } };
          await new Promise(() => {});
        },
      },
    },
    withTimeout: p => p,
    sleep: () => new Promise((r) => setTimeout(r, 10)),
    invalidateMemoryLearnerSession: (force) => { if (force) { invalidated = true; mockB.shutdownRequested = true; done(); } },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  };
  const ev = createDshEvents(mockB);
  void ev.pumpMux();
  await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('learner retry timeout')), 1000))]);
  assert.equal(learnerRespondCount, 2, '学习会话自动回执失败应重试一次');
  assert.equal(invalidated, true, '学习会话回执全败后必须失效并释放等待');
});

test('连续 tool/call 在 2x 租约上限内滑动续租，缺 callId 不泄漏，看门狗受 2x 上限约束', async () => {
  const { createSchedulerExecutor } = await import('../src/scheduler/executor.js');
  const { createTurnWatchdog } = await import('../src/scheduler/watchdog.js');
  const c = clock();
  const runs = [];
  let scheduler;
  const b = { ...c, cfg: { modes: { engine: { reserved2: true } } }, TURN_BUSY_LEASE_MS: 100,
    state: { sessions: {} }, collectors: new Map(), reverse: new Map(),
    v2TurnStartAt: new Map(), pendingWakeKeys: new Set(), dshReady: true, log: () => {}, disarmPendingWakeLease: () => {},
    modeForKey: () => 'reserved2', isSessionAllowedInCurrentMode: () => true,
    deliverPromptNow: async (key, promptText, opts) => {
      b.state.sessions[key] = 'sid-slide';
      b.reverse.set('sid-slide', key);
      scheduler.turnEngine.bind(key, opts.schedulerTurnId, 'sid-slide');
      runs.push(promptText);
      return { ok: true };
    },
  };
  scheduler = createSchedulerExecutor(b);
  try {
    await scheduler.schedulePrompt('group:456', 'first');
    await scheduler.schedulePrompt('group:456', 'second');
    // 缺 callId 的 tool/call 不泄漏 pendingToolCalls
    scheduler.scheduledTurnEvent('group:456', 'sid-slide', { type: 'tool/call', data: { name: 'noop' } });
    assert.deepEqual(scheduler.turnEngine.activeLease('group:456')?.pendingToolCalls ?? [], []);
    await c.advance(60);
    scheduler.scheduledTurnEvent('group:456', 'sid-slide', { type: 'tool/call', data: { callId: 'c1', name: 'qq_wait_for_messages' } });
    await c.advance(60); // 120ms：第一次顺延到 160ms
    assert.equal(runs.length, 1);
    scheduler.scheduledTurnEvent('group:456', 'sid-slide', { type: 'tool/call', data: { callId: 'c2', name: 'qq_wait_for_messages' } });
    await c.advance(50); // 170ms：第二次 tool/call 滑动顺延到 200ms (2x 上限)，仍未放行 second
    assert.equal(runs.length, 1, '连续 tool/call 应在 2x 租约上限内滑动续租');
    await c.advance(40); // 210ms：超过 2*100ms 上限，释放并执行 second
    assert.equal(runs.length, 2, '超过 2x 租约上限后必须释放租约');
  } finally { scheduler.cancelAllScheduledTurns('test-complete'); }

  // watchdog：超出 2*TURN_BUSY_LEASE_MS 时不得继续豁免
  let stopped = 0;
  const collectors = new Map([['s-hung', {}]]);
  const v2TurnStartAt = new Map([['s-hung', 1_000]]);
  const toolCallNames = new Map([['s-hung', new Map([['c1', 'qq_wait_for_messages']])]]);
  const wd = createTurnWatchdog({
    collectors,
    reverse: new Map([['s-hung', 'group:456']]),
    cfg: { turnStallMs: 1000 },
    TURN_BUSY_LEASE_MS: 5000,
    modeForKey: () => 'reserved2',
    schedulerEnabled: () => true,
    log: () => {},
    appendActivity: () => {},
    api: { stopSessionWork: async () => { stopped++; } },
    social: { silentTurns: new Map(), exitingSessions: new Set() },
    socialState: () => ({}),
    replayPendingWakeReasonsV2: () => {},
    notifyOwnerWatchdogIssue: () => {},
  }, {
    v2TurnStartAt,
    turnLeaseNoted: new Set(),
    sendToolSucceededSessions: new Set(),
    pendingSendToolCalls: new Map(),
    toolCallNames,
    pendingWakeKeys: new Set(),
    dispatch: (_sid, _d, fn) => fn(),
  });
  wd.lastEventAt.set('s-hung', 1_000);
  wd.toolCallAt.set('s-hung', 9_500);
  assert.deepEqual(wd.checkStalledTurns(10_500), [], '在 2x 租约与活跃间隔内豁免');
  assert.deepEqual(wd.checkStalledTurns(12_000), ['s-hung'], '超过 2x 租约上限即使近期仍在调工具也必须恢复卡死');
  await Promise.resolve();
  assert.equal(stopped, 1);
});

test('撤权回执最终失败触发活动日志与管理员告警，并通过有界补偿重试恢复或耗尽收敛', async () => {
  const { createPendingQuestions } = await import('../src/conversations/pending.js');
  const activities = [];
  const ownerAlerts = [];
  let respondCalls = 0;
  const pq = createPendingQuestions({
    pending: new Map(),
    cfg: { ownerQQ: '1000', pendingCancelRetryDelaysMs: [15, 30] },
    api: {
      respond: async () => {
        respondCalls += 1;
        if (respondCalls <= 2) throw new Error('dsh down');
        return { ok: true };
      },
    },
    withTimeout: p => p,
    log: () => {},
    appendActivity: (msg) => activities.push(msg),
    sendToQQ: async (to, text) => { ownerAlerts.push({ to, text }); },
    setTimeout,
    clearTimeout,
  });

  await pq.cancelPendingEntry({ kind: 'approval', key: 'group:456', clientId: 'c1', eventId: 'ev-comp' });
  assert.equal(respondCalls, 2, '初次应尝试 2 次并全部失败');
  assert.equal(activities.length, 1);
  assert.match(activities[0], /撤权回执失败 group:456/);
  assert.equal(ownerAlerts.length, 1);
  assert.equal(ownerAlerts[0].to, 'private:1000');
  assert.match(ownerAlerts[0].text, /自动补偿重试/);
  assert.equal(pq.getPendingCompensationCount(), 1);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(respondCalls, 3, '延迟补偿重试应补发成功');
  assert.equal(pq.getPendingCompensationCount(), 0);
  assert.match(activities[1], /撤权回执补偿成功 group:456/);

  const exhaustedActivities = [];
  let failCalls = 0;
  const pqFail = createPendingQuestions({
    pending: new Map(),
    cfg: { pendingCancelRetryDelaysMs: [10] },
    api: { respond: async () => { failCalls += 1; throw new Error('still down'); } },
    withTimeout: p => p,
    log: () => {},
    appendActivity: (msg) => exhaustedActivities.push(msg),
    setTimeout,
    clearTimeout,
  });
  await pqFail.cancelPendingEntry({ kind: 'question', key: 'private:222', clientId: 'c2', eventId: 'ev-exhaust' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(failCalls, 3, '初次 2 次 + 1 轮补偿后耗尽');
  assert.equal(pqFail.getPendingCompensationCount(), 0);
  assert.match(exhaustedActivities.at(-1), /撤权回执补偿耗尽 private:222/);
  pqFail.clearPendingCompensations();
});

test('U-01：撤权补偿随状态落盘，重启后 DSH 就绪续补并幂等', async () => {
  const { createPendingQuestions } = await import('../src/conversations/pending.js');
  const state = { sessions: {} };
  let saves = 0;
  let respondCalls = 0;
  const pq1 = createPendingQuestions({
    pending: new Map(),
    state,
    saveState: () => { saves += 1; return true; },
    cfg: { pendingCancelRetryDelaysMs: [60_000] },
    api: { respond: async () => { respondCalls += 1; throw new Error('dsh down'); } },
    withTimeout: p => p,
    log: () => {},
    setTimeout,
    clearTimeout,
  });
  await pq1.cancelPendingEntry({ kind: 'approval', key: 'group:456', clientId: 'c1', eventId: 'ev-restart' });
  assert.equal(pq1.getPendingCompensationCount(), 1);
  assert.ok(saves > 0, '补偿登记必须触发状态落盘');
  assert.equal(state.pendingCompensations.length, 1, '补偿队列必须随状态持久化');
  assert.equal(state.pendingCompensations[0].entry.eventId, 'ev-restart');
  assert.equal(state.pendingCompensations[0].outcome.value, 'rejected');
  // 模拟进程重启：旧实例内存映射随进程消失（定时器已 unref 不阻塞退出），磁盘记录保留；
  // 不调用 clearPendingCompensations——那是显式清空，语义上应同步清除磁盘记录。

  // 新实例从同一份状态恢复（模拟重启后 DSH 就绪）
  const pq2 = createPendingQuestions({
    pending: new Map(),
    state,
    saveState: () => { saves += 1; return true; },
    cfg: { pendingCancelRetryDelaysMs: [10] },
    api: { respond: async () => { respondCalls += 1; return { ok: true }; } },
    withTimeout: p => p,
    log: () => {},
    appendActivity: () => {},
    setTimeout,
    clearTimeout,
  });
  assert.equal(pq2.restorePendingCompensations(), 1, '重启后必须恢复落盘的补偿');
  assert.equal(pq2.restorePendingCompensations(), 0, '重复恢复必须幂等');
  assert.equal(pq2.getPendingCompensationCount(), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(respondCalls, 3, '初次 2 次失败 + 重启续补 1 次成功');
  assert.equal(pq2.getPendingCompensationCount(), 0);
  assert.equal(state.pendingCompensations, undefined, '续补成功后磁盘记录必须清除');
});

test('U-01：停机标志阻止补偿继续发起回执，在途队列保留落盘供重启续补', async () => {
  const { createPendingQuestions } = await import('../src/conversations/pending.js');
  const state = { sessions: {} };
  let respondCalls = 0;
  const mockB = {
    pending: new Map(),
    state,
    saveState: () => true,
    cfg: { pendingCancelRetryDelaysMs: [10, 10] },
    api: { respond: async () => { respondCalls += 1; throw new Error('dsh down'); } },
    withTimeout: p => p,
    log: () => {},
    setTimeout,
    clearTimeout,
    shutdownRequested: false,
  };
  const pq = createPendingQuestions(mockB);
  await pq.cancelPendingEntry({ kind: 'question', key: 'group:789', clientId: 'c3', eventId: 'ev-shutdown' });
  assert.equal(respondCalls, 2);
  assert.equal(pq.getPendingCompensationCount(), 1);
  mockB.shutdownRequested = true; // 模拟 SIGTERM：在途补偿不再发起新回执
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(respondCalls, 2, '停机后不得继续发起回执');
  assert.equal(state.pendingCompensations.length, 1, '停机时在途补偿必须保留落盘供重启续补');
  pq.clearPendingCompensations();
  assert.equal(state.pendingCompensations, undefined, '显式清理必须同步清除磁盘记录');
});
