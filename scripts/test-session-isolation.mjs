// 检查会话隔离：真实桥接代码在内存里跑，不连 QQ 和 DSH
// A 群发送卡住时，B 群从结束到发出要小于 1 秒
// 同一个会话严格按顺序；开启开关可退回旧的等待方式
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
// 跑一个测试用例，失败就记下来
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
// 等一小会儿
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = 'group:456', B = 'group:789', SA = 'session-a', SB = 'session-b';
const allow = { private: ['123'], groups: ['456', '789'] };

// 给测试桥接挂上两个群的会话
function attach(h) {
  h.setMode('chat');
  for (const [key, sid] of [[A, SA], [B, SB]]) {
    h.state.sessions[key] = sid;
    h.state.sessionPolicies[key] = h.sessionPolicy(key);
    h.reverse.set(sid, key);
  }
}
// 造一条事件帧
const ev = (sessionId, type, data) => ({ payload: { type: 'session/event', sessionId, event: { type, data } } });
// 造一个完整回合：开始、回复、结束
const turn = (sid, id, text) => [
  ev(sid, 'turn/start', { turn: id }),
  ev(sid, 'assistant/message', { turn: id, message: { content: [{ type: 'text', text }] } }),
  ev(sid, 'turn/end', { turn: id, reason: { kind: 'completed' } }),
];

// 事件流：需要时喂一帧，不喂就挂着，像一条活着的连接
function feedMux(h) {
  const frames = []; let wake = null;
  h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] } } }) };
  h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
  h.api.events.mux = async function* () {
    for (;;) {
      while (frames.length) yield frames.shift();
      await new Promise((resolve) => { wake = resolve; });
    }
  };
  return (...items) => { frames.push(...items.flat()); wake?.(); };
}

// A 群的 QQ 发送卡住，B 群照常即时
function stallGroupA(h) {
  const sent = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.bot.sendGroupMessage = async (id, text) => {
    if (String(id) === '456') await gate;
    sent.push({ id: String(id), text, at: Date.now() });
  };
  return { sent, release };
}

await test('A 群发送卡住时，B 群 turn/end → QQ 发送 < 1 s；A 群自身保持 FIFO', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0 } });
  try {
    attach(h);
    const feed = feedMux(h);
    const { sent, release } = stallGroupA(h);
    void h.pumpMux();
    feed(turn(SA, 'A1', 'A 的第一条'), turn(SA, 'A2', 'A 的第二条'));
    await sleep(100);
    const fedAt = Date.now();
    feed(turn(SB, 'B1', 'B 的回复'));
    await sleep(300);
    const b = sent.find((m) => m.id === '789');
    assert.ok(b, 'B 群必须在 A 群卡住期间发出');
    assert.ok(b.at - fedAt < 1000, `B 群延迟 ${b.at - fedAt}ms`);
    assert.equal(sent.filter((m) => m.id === '456').length, 0, 'A 群仍卡着');
    assert.ok(h.dispatchStats.maxDepth >= 2, 'A 群第二条在队列里排队');
    release();
    await sleep(300);
    assert.deepEqual(sent.filter((m) => m.id === '456').map((m) => m.text), ['A 的第一条', 'A 的第二条']);
  } finally { await h.close(); }
});

await test('A 群一次发送超过告警时限：只告警，第二段仍等第一段真正结束（同会话不并发）', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0, dsh: { authToken: 'fixture-only', dispatchSlowMs: 50 } } });
  try {
    attach(h);
    const feed = feedMux(h);
    const { sent, release } = stallGroupA(h);
    let calls = 0;
    const stalled = h.bot.sendGroupMessage;
    h.bot.sendGroupMessage = async (...args) => { calls++; return stalled(...args); };
    void h.pumpMux();
    feed(turn(SA, 'A1', 'A 的第一条'), turn(SA, 'A2', 'A 的第二条'));
    await sleep(300);
    assert.equal(h.dispatchStats.overtime, 1, '超时只告警一次');
    assert.equal(calls, 1, '第一段没结束，第二段不起跑');
    release();
    await sleep(300);
    assert.deepEqual(sent.map((m) => m.text), ['A 的第一条', 'A 的第二条']);
  } finally { await h.close(); }
});

await test('dsh.inlineDispatch=true 回退旧行为：泵内联等待 A 群发送', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0, dsh: { authToken: 'fixture-only', inlineDispatch: true } } });
  try {
    attach(h);
    const feed = feedMux(h);
    const { sent, release } = stallGroupA(h);
    void h.pumpMux();
    feed(turn(SA, 'A1', 'A 的第一条'), turn(SB, 'B1', 'B 的回复'));
    await sleep(300);
    assert.equal(sent.length, 0, '内联模式下 B 群排在 A 群发送后面');
    release();
    await sleep(300);
    assert.deepEqual(sent.map((m) => m.id), ['456', '789']);
  } finally { await h.close(); }
});

await test('A 群发送抛错只记日志，不打断事件流；B 群照常', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0 } });
  try {
    attach(h);
    const feed = feedMux(h);
    const sent = [];
    h.bot.sendGroupMessage = async (id, text) => {
      if (String(id) === '456') throw new Error('gateway down');
      sent.push({ id: String(id), text });
    };
    void h.pumpMux();
    feed(turn(SA, 'A1', 'A 的回复'), turn(SB, 'B1', 'B 的回复'), turn(SB, 'B2', 'B 的第二条'));
    await sleep(300);
    assert.deepEqual(sent.map((m) => m.text), ['B 的回复', 'B 的第二条']);
  } finally { await h.close(); }
});

// B4) 卡死回合保底：只中断卡死的那个会话
await test('A 会话回合卡死：只取消 A、只提示 A、释放 A 的忙碌；B 全程正常', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0, turnStallMs: 1000 } });
  try {
    attach(h);
    const feed = feedMux(h);
    const sent = [];
    h.bot.sendGroupMessage = async (id, text) => { sent.push({ id: String(id), text }); };
    void h.pumpMux();
    feed(ev(SA, 'turn/start', { turn: 'A1' }), ev(SB, 'turn/start', { turn: 'B1' }));
    await sleep(100);
    assert.deepEqual(h.checkStalledTurns(Date.now() + 500), [], '未到阈值不动');
    // B 有正在跑的工具调用，例如长轮询，不算卡死
    feed(ev(SB, 'tool/call', { callId: 'c1', name: 'mcp__snowluma__qq_wait_for_messages' }));
    await sleep(100);
    const cancelledBefore = h.calls.cancelled.length;
    assert.deepEqual(h.checkStalledTurns(Date.now() + 5000), [SA]);
    await sleep(100);
    assert.deepEqual(h.calls.cancelled.slice(cancelledBefore), [SA], '只取消 A 的回合');
    assert.equal(h.collectors.has(SA), false, 'A 的忙碌状态已释放');
    assert.equal(h.collectors.has(SB), true, 'B 的回合不受影响');
    assert.deepEqual(sent, [{ id: '456', text: '⚠️ 本会话处理超时，已中断' }]);
    assert.deepEqual(h.checkStalledTurns(Date.now() + 5000), [], '同一回合不重复处理');
        // B 照常跑完，并把回复发出去
    feed(ev(SB, 'tool/result', { message: { source: { callId: 'c1' }, content: [{ isError: false }] } }),
      ev(SB, 'assistant/message', { turn: 'B1', message: { content: [{ type: 'text', text: 'B 的回复' }] } }),
      ev(SB, 'turn/end', { turn: 'B1', reason: { kind: 'completed' } }));
    await sleep(200);
    assert.deepEqual(sent.at(-1), { id: '789', text: 'B 的回复' });
    // A 再次卡死：短时间内不重复提示
    feed(ev(SA, 'turn/start', { turn: 'A2' }));
    await sleep(100);
    assert.deepEqual(h.checkStalledTurns(Date.now() + 5000), [SA]);
    await sleep(100);
    assert.equal(sent.filter((m) => m.id === '456').length, 1);
  } finally { await h.close(); }
});

await test('卡死兜底清掉静默名额与退场标记；工具结果永远不来时超过租约也兜底', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0, turnStallMs: 1000 } });
  try {
    attach(h);
    const feed = feedMux(h);
    const sent = [];
    h.bot.sendGroupMessage = async (id, text) => { sent.push({ id: String(id), text }); };
    void h.pumpMux();
    h.social.silentTurns.set(SA, [{ ts: Date.now() }]);
    h.social.exitingSessions.add(SA);
    feed(ev(SA, 'turn/start', { turn: 'A1' }), ev(SB, 'turn/start', { turn: 'B1' }), ev(SB, 'tool/call', { callId: 'lost', name: 'mcp__snowluma__qq_wait_for_messages' }));
    await sleep(100);
    assert.deepEqual(h.checkStalledTurns(Date.now() + 5000), [SA], '在途工具在租约内仍豁免');
    assert.equal(h.social.silentTurns.has(SA), false, '静默名额作废');
    assert.equal(h.social.exitingSessions.has(SA), false, '退场标记作废');
    assert.deepEqual(h.checkStalledTurns(Date.now() + 16 * 60 * 1000), [SB], '工具结果 16 分钟没来：不再豁免');
    // A 的下一条真回复照常发出，不被残留名额吞掉
    feed(turn(SA, 'A2', 'A 的真回复'));
    await sleep(200);
    assert.ok(sent.some((m) => m.text === 'A 的真回复'));
  } finally { await h.close(); }
});

await test('排队期间会话被换掉：旧会话的回合发送丢弃，不发到群里', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0 } });
  try {
    attach(h);
    const feed = feedMux(h);
    const { sent, release } = stallGroupA(h);
    void h.pumpMux();
    feed(turn(SA, 'A1', 'A 的第一条'), turn(SA, 'A2', '旧会话的第二条'));
    await sleep(100);
    h.state.sessions[A] = 'session-a2'; /* 例如重置之后重建 */
    release();
    await sleep(300);
    assert.deepEqual(sent.map((m) => m.text), ['A 的第一条']);
  } finally { await h.close(); }
});

await test('出站积压与断线：积压超上限丢最旧回合发送；断线时未轮到的任务保留，恢复后照发', async () => {
  const h = await bridgeHarness({ config: { allow, sendDelayMs: 0 } });
  try {
    attach(h);
    h.setMode('chat');
    const frames = Array.from({ length: 25 }, (_, i) => turn(SA, `A${i}`, `第${i}条`)).flat();
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: { presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }] } } }) };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } });
    let connects = 0;
    h.api.events.mux = async function* () {
      if (connects++ === 0) { for (const f of frames) yield f; return; } /* 第一条连接喂完就断线 */
      await new Promise(() => {}); /* 重连后保持连接 */
    };
    const { sent, release } = stallGroupA(h);
    void h.pumpMux().catch(() => {});
    await sleep(5600); /* 断线后最多等 5 秒让它排空 */
    assert.equal(h.dispatchStats.dropped, 4, '25 条里 1 条在途、20 条排队，超出的 4 条最旧回合发送被丢');
    release();
    await sleep(300);
    const texts = sent.map((m) => m.text);
    assert.equal(texts.length, 21, '断线时排队的 20 条没有丢');
    assert.equal(texts[0], '第0条');
    assert.equal(texts.at(-1), '第24条');
  } finally { await h.close(); }
});

await test('卡死兜底：turnStallMs=0 关闭；closed-agent 不启用', async () => {
  const off = await bridgeHarness({ config: { allow, turnStallMs: 0 } });
  try {
    attach(off);
    off.trackTurnEvent(SA, { type: 'turn/start', data: { turn: 'A1' } });
    off.v2TurnStartAt.set(SA, Date.now());
    assert.deepEqual(off.checkStalledTurns(Date.now() + 3600_000), []);
  } finally { await off.close(); }
  const h = await bridgeHarness({ config: { allow, turnStallMs: 1000 } });
  try {
    h.setMode('closed-agent');
    h.state.sessions['private:123'] = 'session-owner';
    h.reverse.set('session-owner', 'private:123');
    h.trackTurnEvent('session-owner', { type: 'turn/start', data: { turn: 'O1' } });
    h.v2TurnStartAt.set('session-owner', Date.now());
    assert.deepEqual(h.checkStalledTurns(Date.now() + 3600_000), []);
    assert.equal(h.collectors.has('session-owner'), true);
  } finally { await h.close(); }
});

// B3) 写盘合批：消息热路径不再每条都整份写盘，换名写一次
const socialFile = (h) => path.join(h.temp, 'state', 'social-v2.json');
// 取文件的编号，用来看有没有重写
const inode = (file) => { try { return fs.statSync(file).ino; } catch { return 0; } };

await test('1000 条入站消息：热路径 0 次同步写盘，1 s 内合批落盘一次且内容完整', async () => {
  const h = await bridgeHarness({ config: { allow, socialV2: { flushIntervalMs: 200 } } });
  try {
    h.setMode('reserved2');
    h.saveSocialV2State();
    const file = socialFile(h);
    const before = inode(file);
    assert.ok(before, 'baseline state file exists');
    const startedAt = Date.now();
    for (let i = 0; i < 1000; i++) h.appendSocialV2Message(i % 2 ? A : B, '群友', `消息 ${i}`, `消息 ${i}`, false, false, `m-${i}`);
    const elapsed = Date.now() - startedAt;
    assert.equal(inode(file), before, '热路径不得同步写盘');
    assert.ok(elapsed < 1000, `1000 条消息入库耗时 ${elapsed}ms`);
    await sleep(400);
    assert.notEqual(inode(file), before, '合批窗口到期后落盘');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.conversations[A].recentMessages.at(-1).text, '消息 999');
    const afterFlush = inode(file);
    await sleep(400);
    assert.equal(inode(file), afterFlush, '没有新消息就不再写');
    // 关机前强制把数据写盘
    h.appendSocialV2Message(A, '群友', '关机前', '关机前', false, false, 'm-last');
    h.flushSocialV2State();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).conversations[A].recentMessages.at(-1).text, '关机前');
  } finally { await h.close(); }
});

await test('socialV2.flushIntervalMs=0 回退到每条消息同步写', async () => {
  const h = await bridgeHarness({ config: { allow, socialV2: { flushIntervalMs: 0 } } });
  try {
    h.setMode('reserved2');
    h.saveSocialV2State();
    const before = inode(socialFile(h));
    h.appendSocialV2Message(A, '群友', '一条', '一条', false, false, 'm-1');
    assert.notEqual(inode(socialFile(h)), before);
  } finally { await h.close(); }
});

console.log(failures ? `\nFAILED ${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
