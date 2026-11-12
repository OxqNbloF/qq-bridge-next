// 检查回复发送流程：真实桥接代码在内存里跑，不发真消息
// 1. 图片加文字要按到达顺序发，图片读得慢也不能被超车
// 2. 提示词被拒时不外发原始错误，不同模式处理不同
// 3. 断线期间跑完的回复要重连后补发，同一条不重发
// 4. 已由发送工具发出的、静默的、空的回合都不补发
// 5. reserved2 模式不补发，文字由 AI 自己用工具发
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
// 跑一个测试用例，失败就记下来
async function test(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

const KEY = 'group:456';
const SID = 'session-delivery';
// 等一小会儿
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 给测试桥接挂上会话
function attachSession(h) {
  h.setMode('chat');
  h.state.sessions[KEY] = SID;
  h.state.sessionPolicies[KEY] = h.sessionPolicy(KEY);
  h.reverse.set(SID, KEY); /* 真实桥接在建立会话时维护，夹具要同步 */
}

// 造一条事件记录
const entry = (type, data) => ({ type: 'event', event: { type, data } });
// 造回合开始的记录
const start = (turn) => entry('turn/start', { turn });
// 造一条回复记录
const reply = (turn, text) => entry('assistant/message', {
  turn,
  message: { content: [{ type: 'text', text }] }
});
// 造回合结束的记录
const end = (turn, kind = 'completed') => entry('turn/end', { turn, reason: { kind } });
// 造发送工具调用的记录
const sendToolCall = (callId) => entry('tool/call', { callId, name: 'mcp__snowluma__qq_send_group_message', arguments: '{}' });
// 造发送工具返回的记录
const sendToolResult = (callId) => entry('tool/result', {
  message: { source: { callId }, content: [{ isError: false }] }
});
// 造一个完整回合的记录
const turn = (id, text, { kind = 'completed', sendTool = false } = {}) => [
  start(id),
  ...(text ? [reply(id, text)] : []),
  ...(sendTool ? [sendToolCall(`call-${id}`), sendToolResult(`call-${id}`)] : []),
  end(id, kind)
];

// 带序号的状态记录：真实事件自带递增序号，补发靠它
const turnWithSeq = (id, text, startSeq, endSeq) => [
  { type: 'event', seq: startSeq, event: { type: 'turn/start', data: { turn: id } } },
  ...(text ? [{ type: 'event', seq: startSeq + 1, event: { type: 'assistant/message', data: { turn: id, message: { content: [{ type: 'text', text }] } } } }] : []),
  { type: 'event', seq: endSeq, event: { type: 'turn/end', data: { turn: id, reason: { kind: 'completed' } } } }
];

await test('图片先到、文本后到：普通聊天也必须按到达顺序提交（图片解析慢不超车）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    let imageStarted;
    const started = new Promise((resolve) => { imageStarted = resolve; });
    h.bot.getImage = async () => {
      imageStarted();
      await sleep(150);
      // 1×1 的 PNG，和假网关返回的图片一致
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    };
    const imageEvent = {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8001,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '[图片]', message: [{ type: 'image', data: { file: 'fixture.png' } }]
    };
    const textEvent = {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8002,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '第二句', message: [{ type: 'text', data: { text: '第二句' } }]
    };

    const imageDelivery = h.handleIncoming('group', '456', imageEvent, h.cfg);
    await started; /* 图片已进队列，正卡在读媒体内容 */
    const textDelivery = h.handleIncoming('group', '456', textEvent, h.cfg);
    await Promise.all([imageDelivery, textDelivery]);

    assert.equal(h.calls.prompts.length, 2, '两条消息都应提交');
    const [first, second] = h.calls.prompts;
    assert.ok(first.content.some((part) => part.type === 'image'), '第一条提交必须包含图片（不能被后到的文本超车）');
    assert.ok(second.content.length === 1 && second.content[0].type === 'text' && second.content[0].text.includes('第二句'), '第二条提交应为纯文本');
  } finally { await h.close(); }
});

await test('普通聊天改走 promptQueues 后仍按原语义发送 ack', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, ackMessage: '已收到' } });
  try {
    attachSession(h);
    await h.handleIncoming('group', '456', {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8101,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }]
    }, h.cfg);
    assert.equal(h.calls.prompts.length, 1, '消息应照常提交');
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['已收到'], 'ack 仍应在提交成功后发送');
  } finally { await h.close(); }
});

await test('#104 prompt 拒绝不外发原始错误：reserved2 保持私密，其他模式固定提示并节流', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    const raw = '503 {"gateway_hint":"private-account-pool-detail"}';
    h.api.sessions.prompt = async () => ({
      result: { ok: false, error: { code: 'UPSTREAM_ERROR', message: raw } }
    });

    h.setMode('reserved2');
    const rejected = await h.deliverPrompt(KEY, 'fixture');
    assert.equal(rejected.ok, false);
    assert.equal(h.calls.sent.length, 0, 'reserved2 不得自动外发 prompt 拒绝详情');

    h.setMode('chat');
    await h.deliverPrompt(KEY, 'fixture');
    await h.deliverPrompt(KEY, 'fixture');
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['⚠️ 暂时无法处理消息，请稍后再试。']);
    assert.ok(!h.calls.sent.some((m) => m.text.includes('private-account-pool-detail')));
  } finally { await h.close(); }
});

await test('重连快照：补发断线期间完成的回复，且重复快照不重发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 第一份状态只有历史，没有已读位置，先初始化
    await h.handleSessionSnapshot(SID, { records: turn('T1', '历史回复') });
    assert.equal(h.calls.sent.length, 0, '首次建立游标时不得补发历史回复');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');

    // 断线期间跑完第二回合，实时结束事件没到，状态里有回复
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '历史回复'), ...turn('T2', '断线期间的回复')] });
    assert.equal(h.calls.sent.length, 1, '断线期间完成的回复应补发一次');
    assert.equal(h.calls.sent[0].text, '断线期间的回复');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');

    // 重复发同一份状态，每次重连都会重发，不能重复补
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '历史回复'), ...turn('T2', '断线期间的回复')] });
    assert.equal(h.calls.sent.length, 1, '重复快照不得重复补发');

    // 已读位置记到文件里，桥接重启后还能去重
    const file = path.join(h.temp, 'state', 'delivery-cursors.json');
    assert.ok(fs.existsSync(file), '交付游标应持久化到 state/delivery-cursors.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.sessions[SID].deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('同一会话并发到达两份相同快照也只补发一次', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    const records = [...turn('T1', 'anchor'), ...turn('T2', '并发快照回复')];
    await Promise.all([
      h.handleSessionSnapshot(SID, { records }),
      h.handleSessionSnapshot(SID, { records })
    ]);
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['并发快照回复'], '并发快照必须串行并去重');
  } finally { await h.close(); }
});

await test('live turn/end 已交付的回合不会在重连快照里重发（含工具已发送的回合）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 模拟实时通道完整跑完第一回合
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 'T1' } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 'T1', message: { content: [{ type: 'text', text: '已经发过的回复' }] } } });
    const ended = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 'T1', reason: { kind: 'completed' } } });
    assert.equal(ended.ended.reason.kind, 'completed');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');

    await h.handleSessionSnapshot(SID, { records: turn('T1', '已经发过的回复') });
    assert.equal(h.calls.sent.length, 0, 'live 已交付的回合不得补发');

    // 第二回合断线期间完成，但已用发送工具发出，只推进位置
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '已经发过的回复'), ...turn('T2', '工具已发', { sendTool: true })] });
    assert.equal(h.calls.sent.length, 0, '工具已发送的回合不得自动补发');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('空回复 / 中止回合只推进游标，不补发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', ''), ...turn('T3', '被中止', { kind: 'aborted' })] });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T3');
  } finally { await h.close(); }
});

await test('首轮就崩溃（没有 deliveredTurn）：用 inflight 锚点补发该回合及之后', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 模拟上个进程看到回合开始就退出了，只剩进行中的位置
    h.deliveryCursors.set(SID, { deliveredTurn: '', inflightTurn: 'T1' });
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '首轮回复'), ...turn('T2', '第二轮回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['首轮回复', '第二轮回复']);
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('已交付锚点掉出窗口时，仍能用 inflight 锚点补发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    h.deliveryCursors.set(SID, { deliveredTurn: 'T0', deliveredSeq: -1, inflightTurn: 'T2', inflightSeq: -1 });
    await h.handleSessionSnapshot(SID, { records: [...turn('T2', '窗口内新回复'), ...turn('T3', '后续回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['窗口内新回复', '后续回复']);
  } finally { await h.close(); }
});

await test('发送失败不推进游标，下一次快照重试', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    const original = h.bot.sendGroupMessage.bind(h.bot);
    let failOnce = true;
    h.bot.sendGroupMessage = async (...args) => {
      if (failOnce) { failOnce = false; throw new Error('fixture send failure'); }
      return original(...args);
    };
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', '需要重试的回复')] });
    assert.equal(h.calls.sent.length, 0, '发送失败时不能算已交付');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1', '失败后游标应停在失败回合之前');

    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', '需要重试的回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['需要重试的回复'], '下一次快照应重试成功');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('seq 水位：旧游标掉出快照窗口后，窗口内的新回合仍能补发且不重复', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 实时跑完第一回合后断线，状态窗口被截断，它不在记录里
    h.trackTurnEvent(SID, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
    h.trackTurnEvent(SID, { type: 'assistant/message', seq: 6, data: { turn: 'T1', message: { content: [{ type: 'text', text: '已经发过' }] } } });
    h.trackTurnEvent(SID, { type: 'turn/end', seq: 10, data: { turn: 'T1', reason: { kind: 'completed' } } });
    assert.equal(h.deliveryCursors.get(SID).deliveredSeq, 10);

    const window = [...turnWithSeq('T2', '断线回复一', 21, 30), ...turnWithSeq('T3', '断线回复二', 31, 40)];
    await h.handleSessionSnapshot(SID, { records: window });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['断线回复一', '断线回复二'], '窗口内 seq > 10 的回合都应补发');
    assert.equal(h.deliveryCursors.get(SID).deliveredSeq, 40);

    await h.handleSessionSnapshot(SID, { records: window });
    assert.equal(h.calls.sent.length, 2, '同一窗口重放不得重复补发');
  } finally { await h.close(); }
});

await test('reserved2 不补发（内部文本不能当普通聊天回复发出）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    h.setMode('reserved2');
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'reserved2 内部输出') });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID), undefined, 'reserved2 不应改动补发游标');
  } finally { await h.close(); }
});

await test('模式未确定时快照先暂存，refreshMode 之后再决定（不能按初始 chat 补发）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    // 注意这里故意不设模式，模拟状态比模式检查先到
    h.state.sessions[KEY] = SID;
    h.state.sessionPolicies[KEY] = h.sessionPolicy(KEY);
    h.reverse.set(SID, KEY);
    await h.handleSessionSnapshot(SID, { records: turn('T1', '历史回复') });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID), undefined, '模式未知时不得读写交付游标');

    await h.refreshMode(); /* 设置里没有模式，退回本地文件，缺了就用 chat */
    await h.replayDeferredDeliveries();
    assert.equal(h.calls.sent.length, 0, '暂存快照只用于建立游标，不得补发历史');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');
  } finally { await h.close(); }
});

console.log(failures === 0 ? '\n✅ 交付链路回归通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
