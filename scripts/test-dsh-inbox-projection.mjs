// 检查 DSH 会话待处理队列的读取，用真实记录的数据
//
// 为什么要有这个文件
// 桥接重置会话前要先清掉 DSH 里没跑的队列
// 以前只从开场那一帧里读队列
// 也就是按会话 id 去 queues 里取
// 新版把队列并进了汇总视图，位置变了
// 要按会话 id 去汇总视图里找队列
// queues 这个键没了，每次重置都会报错
// 队列清不掉，旧任务还在跑，日志里只有一行失败
// 提示「停止旧会话失败」
// 这个 bug 升级后才被发现，说明以前没有测试覆盖
//
// 这里用从真 DSH 记录下来的数据把读取方式钉死
// 结构一变测试就红，不会线上悄悄出问题
//
// 帧里保留真实的层级和键名，连字符键也保留
// 因为层级写错正是上一版 bug 的样子
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inboxItemsOfProjections,
  inboxItemIds,
  controlBaselineInboxItems,
} from '../src/dsh-client.js';

// 一条真实的待处理消息，内容换成了占位符
const realInboxItem = (id, text) => ({
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: 'rpc-0000-0000-0000-000000000000' },
  role: 'user',
  id,
});

// 汇总视图的结构，只留测试关心的键
const projectionValues = (inbox) => ({
  title: 'QQ 聊天',
  tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...(inbox === undefined ? {} : { inbox }),
});

// 开场那一帧的真实结构
const controlBaseline = (sessions) => ({
  type: 'baseline',
  value: {
    projections: Object.fromEntries(
      Object.entries(sessions).map(([id, values]) => [id, { asOfSeq: 7, values }]),
    ),
  },
});

// 1. 读出汇总视图
test('inbox 投影：两个边界一起取，顺序为 next-turn → next-step', () => {
  const values = projectionValues({
    'next-turn': [realInboxItem('m-1', '第一轮')],
    'next-step': [realInboxItem('m-2', '插话')],
  });
  assert.deepEqual(inboxItemsOfProjections(values).map((i) => i.id), ['m-1', 'm-2']);
});

test('inbox 投影：空队列返回空数组（不是错误）', () => {
  assert.deepEqual(inboxItemsOfProjections(projectionValues({ 'next-turn': [], 'next-step': [] })), []);
});

test('inbox 投影：能力缺失（无 inbox 键 / values 为 null）视为无待处理项', () => {
  // 会话没有正在跑的助手时，汇总里可能没有队列
  assert.deepEqual(inboxItemsOfProjections(projectionValues(undefined)), []);
  assert.deepEqual(inboxItemsOfProjections(null), []);
  // 不存在的会话，接口返回 null
  assert.deepEqual(inboxItemsOfProjections(undefined), []);
});

test('inbox 投影：只有一个边界存在时也能解析（另一个是可选能力）', () => {
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-turn': [realInboxItem('m-1', 'x')] })).map((i) => i.id),
    ['m-1'],
  );
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-step': [] })).map((i) => i.id),
    [],
  );
});

test('inbox 投影：结构变了必须显式失败，不能静默当成空队列', () => {
  // 悄悄返回空数组，正是队列清不掉却没人发现的原因
  for (const bad of [
    { 'next-turn': null },
    { 'next-turn': {} },
    { 'next-turn': 'm-1' },
    { 'next-step': 3 },
  ]) {
    assert.throws(
      () => inboxItemsOfProjections(projectionValues(bad)),
      /invalid session inbox projection/,
      `结构 ${JSON.stringify(bad)} 应抛错`,
    );
  }
  assert.throws(() => inboxItemsOfProjections(projectionValues([])), /invalid session inbox projection/);
  assert.throws(() => inboxItemsOfProjections(projectionValues('inbox')), /invalid session inbox projection/);
});

// 2. 取消息 id
test('itemId 抽取：取出 MessageId 字符串', () => {
  assert.deepEqual(
    inboxItemIds([realInboxItem('m-1', 'a'), realInboxItem('m-2', 'b')]),
    ['m-1', 'm-2'],
  );
});

test('itemId 抽取：缺 id / id 非字符串必须抛错（否则 updateQueue 无从下手）', () => {
  for (const bad of [
    [{ content: [] }],
    [{ id: '' }],
    [{ id: 42 }],
    [{ id: null }],
    [null],
    [undefined],
  ]) {
    assert.throws(() => inboxItemIds(bad), /invalid session inbox item/, JSON.stringify(bad));
  }
});

// 3. 读出开场帧的真实结构
test('control baseline：从 projections[<sessionId>].values.inbox 取队列', () => {
  const frame = controlBaseline({
    'session-a': projectionValues({
      'next-turn': [realInboxItem('m-a1', '给 A 的')],
      'next-step': [],
    }),
    'session-b': projectionValues({
      'next-turn': [realInboxItem('m-b1', '给 B 的'), realInboxItem('m-b2', '还有一条')],
      'next-step': [],
    }),
  });
  assert.deepEqual(inboxItemIds(controlBaselineInboxItems(frame, 'session-b')), ['m-b1', 'm-b2']);
  assert.deepEqual(inboxItemIds(controlBaselineInboxItems(frame, 'session-a')), ['m-a1']);
});

test('control baseline：会话不在 baseline 里 ⇒ 没有活动 agent ⇒ 无待处理项', () => {
  const frame = controlBaseline({ 'session-a': projectionValues({ 'next-turn': [], 'next-step': [] }) });
  assert.deepEqual(controlBaselineInboxItems(frame, 'session-zzz'), []);
});

test('control baseline：0.1.7 的旧形状 queues 已不存在——旧字段必须不再被接受', () => {
  // 这条钉住 bug 本身：喂进旧结构必须拿不到队列
  // 而不是像以前那样先撞上检查、每次重置都报错
  const legacy = {
    type: 'baseline',
    value: { queues: { 'session-a': [{ id: 'm-a1' }] } },
  };
  assert.throws(() => controlBaselineInboxItems(legacy, 'session-a'), /invalid session\/control baseline/);
});

test('control baseline：投影表结构不符必须抛错', () => {
  for (const bad of [
    { type: 'baseline', value: {} },
    { type: 'baseline', value: { projections: null } },
    { type: 'baseline', value: { projections: [] } },
    { type: 'baseline', value: { projections: 'x' } },
    { type: 'baseline' },
    undefined,
  ]) {
    assert.throws(
      () => controlBaselineInboxItems(bad, 'session-a'),
      /invalid session\/control baseline/,
      JSON.stringify(bad),
    );
  }
});

test('control baseline：投影项缺 values 时视为能力缺失（无待处理项）', () => {
  const frame = { type: 'baseline', value: { projections: { 'session-a': { asOfSeq: 3 } } } };
  assert.deepEqual(controlBaselineInboxItems(frame, 'session-a'), []);
});
