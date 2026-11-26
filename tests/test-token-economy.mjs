// 用隔离的文件和假对端跑真实桥接逻辑，不连生产
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createSocialStateMachineV1 } from '../src/features/simulation-v1/state-machine.js';
import { createSocialPromptsV1 } from '../src/features/simulation-v1/prompts.js';
import { createSocialLoopV1 } from '../src/features/simulation-v1/loop.js';
import { createToolSendRoutes } from '../src/features/tools/http-face/send.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const ACTIVE = { mode: 'active' };
const DIVING = { mode: 'diving', infinite: true, triggers: { atMention: true, anyMessage: false } };
// 复制一份数据，避免改到原始对象
const plain = (value) => JSON.parse(JSON.stringify(value));
// 取出每条消息的序号
const seqs = (messages) => Array.from(messages, (message) => message.seq);
let failures = 0;
let tests = 0;

// 搭桥接跑一个用例
async function test(name, run, { observe = false, config = {}, files = {} } = {}) {
  tests++;
  const h = await bridgeHarness({ files, config: { ...config, socialV2: {
    wake: { preSleepWaitEnabled: observe, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    privacy: { exposeUserId: true },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  // 向本地接口发一个假请求
  const request = (route, { body, token = st.agentToken, key = KEY, admin = false, unbound = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) { headers['x-agent-call'] = '1'; if (!unbound) headers['x-agent-token'] = token; }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/${admin ? 'console/scheduler' : 'agent'}/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text, { key = KEY, id = `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, media = [], forwards = [] } = {}) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, id, media, '789', forwards);
    return h.getSocialV2State(key).lastUnreadSeq;
  };
  try { await run({ h, st, request, append }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('mark-read acknowledges only the displayed watermark and preserves a message arriving afterwards', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  assert.equal(read.status, 200);
  assert.equal(read.data.readThroughSeq, 1);
  append('new arrival while model thinks');
  const marked = await request('mark-read', { body: { throughSeq: read.data.readThroughSeq } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 1);
  assert.deepEqual(seqs(st.unread), [2]);
  assert.equal(st.lastReadThroughSeq, 1);
});

await test('wake-config atomically acknowledges its displayed watermark while preserving later unread', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  append('unseen new arrival');
  const result = await request('wake-config', { body: { config: ACTIVE, throughSeq: read.data.readThroughSeq } });
  assert.equal(result.status, 200);
  assert.equal(result.data.markedCount, 1);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(st.wakeConfig.mode, 'active');
  assert.deepEqual(seqs(st.unread), [2]);
});

await test('invalid watermarks cannot change unread, wake config, action or observation state', async ({ st, request, append }) => {
  append('protected unread');
  await request('unread');
  st.preSleepWaitObservedAt = Date.now();
  // 记下当前状态，用于比较有没有被改动
  const snapshot = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastActionAt: st.lastActionAt,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt, lastReadThroughSeq: st.lastReadThroughSeq });
  for (const route of ['mark-read', 'wake-config']) {
    for (const throughSeq of [null, '1', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      const before = snapshot();
      const result = await request(route, { body: { throughSeq, config: ACTIVE } });
      assert.equal(result.status, 400, `${route} should reject ${JSON.stringify(throughSeq)}`);
      assert.deepEqual(snapshot(), before, `${route} invalid request must be atomic`);
    }
  }
});

await test('a late slice cannot authorize clearing an earlier unseen message', async ({ st, request, append }) => {
  append('older unseen message');
  append('latest message');
  const latest = await request('unread', { query: '&limit=1' });
  assert.deepEqual(seqs(latest.data.messages), [2]);
  assert.equal(latest.data.readThroughSeq, 0);
  const denied = await request('mark-read', { body: { throughSeq: 2 } });
  assert.equal(denied.status, 400);
  assert.deepEqual(seqs(st.unread), [1, 2]);
  const older = await request('recent', { query: '&limit=1&offset=1' });
  assert.deepEqual(seqs(older.data.messages), [1]);
  assert.equal(older.data.readThroughSeq, 2);
  const marked = await request('mark-read', { body: { throughSeq: older.data.readThroughSeq } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
});

await test('console browsing does not authorize the agent to acknowledge unseen messages', async ({ st, request, append }) => {
  append('console-only read');
  const read = await request('unread', { admin: true });
  assert.equal(read.status, 200);
  const denied = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(denied.status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('my-recent returns an existing safe cursor without authorizing unrelated unread', async ({ h, st, request, append }) => {
  append('not yet seen');
  h.recordSentMessagesV2(KEY, ['my own earlier reply']);
  const mine = await request('my-recent');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.messages.length, 1);
  assert.equal(mine.data.readThroughSeq, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  await request('unread');
  assert.equal((await request('my-recent')).data.readThroughSeq, 1);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('combined close cannot bypass the pre-sleep observation guard', async ({ st, request, append }) => {
  append('still discussing a normal topic');
  const read = await request('unread');
  const before = plain(st.wakeConfig);
  for (const route of ['mark-read', 'wake-config']) {
    const result = await request(route, { body: { throughSeq: read.data.readThroughSeq, config: DIVING } });
    assert.equal(result.status, 400);
    assert.ok(result.data.preSleepWaitRemainingMs > 0);
    assert.deepEqual(seqs(st.unread), [1]);
    assert.deepEqual(plain(st.wakeConfig), before);
  }
}, { observe: true });

await test('a full quiet observation allows a single combined close', async ({ h, st, request, append }) => {
  h.cfg.socialV2.wake.preSleepWaitMs = 100;
  append('ordinary topic');
  const read = await request('unread');
  const waited = await request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
  assert.equal(waited.status, 200);
  assert.equal(waited.data.preSleepWaitSatisfied, true);
  assert.equal(waited.data.readThroughSeq, read.data.readThroughSeq);
  const close = await request('wake-config', { body: { config: DIVING, throughSeq: waited.data.readThroughSeq } });
  assert.equal(close.status, 200);
  assert.equal(close.data.markedCount, 1);
  assert.deepEqual(seqs(st.unread), []);
}, { observe: true });

await test('wait exposes new messages and grants only their actually observed cursor', async ({ st, request, append }) => {
  append('message before wait');
  await request('unread');
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 } });
  const timer = setTimeout(() => append('message during observation'), 60);
  let waited;
  try { waited = await waiting; } finally { clearTimeout(timer); }
  assert.equal(waited.status, 200);
  assert.equal(waited.data.arrived, true);
  assert.equal(waited.data.preSleepWaitObserved, true);
  assert.deepEqual(seqs(waited.data.newMessages), [2]);
  assert.equal(waited.data.readThroughSeq, 2);
  const close = await request('wake-config', { body: { config: DIVING, throughSeq: waited.data.readThroughSeq } });
  assert.equal(close.status, 200);
  assert.equal(close.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
}, { observe: true });

await test('another conversation token, pause, mode and allowlist guards still reject combined close', async ({ h, st, request, append }) => {
  append('protected conversation');
  await request('unread');
  const otherToken = h.getSocialV2State('private:123').agentToken;
  const body = { config: ACTIVE, throughSeq: 1 };
  assert.equal((await request('wake-config', { body, token: otherToken })).status, 403);
  h.socialV2.paused = true;
  assert.equal((await request('wake-config', { body })).status, 403);
  h.socialV2.paused = false;
  h.setMode('chat');
  assert.equal((await request('wake-config', { body })).status, 403);
  h.setMode('reserved2');
  h.cfg.allow.groups = [];
  assert.equal((await request('wake-config', { body })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('legacy mark-read still clears all unread and legacy wake-config preserves unread', async ({ st, request, append }) => {
  append('legacy message');
  const config = await request('wake-config', { body: { config: ACTIVE } });
  assert.equal(config.status, 200);
  assert.deepEqual(seqs(st.unread), [1]);
  append('legacy second message');
  const marked = await request('mark-read', { body: {} });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
});

await test('an invalid wake configuration cannot acknowledge an otherwise valid cursor', async ({ st, request, append }) => {
  append('must remain unread');
  await request('unread');
  const before = plain(st.wakeConfig);
  const result = await request('wake-config', { body: { throughSeq: 1, config: {
    mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, question: false,
      poke: false, anyMessage: false, probability: 0, keywords: [], speakerIds: [] },
  } } });
  assert.equal(result.status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.deepEqual(plain(st.wakeConfig), before);
});

await test('zero and repeated watermarks never acknowledge a later unseen arrival', async ({ st, request, append }) => {
  append('first seen');
  await request('unread');
  assert.equal((await request('mark-read', { body: { throughSeq: 0 } })).data.markedCount, 0);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).data.markedCount, 1);
  append('later unseen');
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).data.markedCount, 0);
  assert.deepEqual(seqs(st.unread), [2]);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
});

await test('combined close respects the separate mark-read and wake-config tool flags', async ({ h, st, request, append }) => {
  append('protected by tool flags');
  await request('unread');
  h.cfg.socialV2.tools.markRead = false;
  // 收尾只做一件事：关掉已读回写时已读位置被忽略
  // 唤醒配置照样生效，未读消息继续挂着
  const ignoredCursor = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(ignoredCursor.status, 200, 'a disabled markRead must not fail the closing call');
  assert.equal(ignoredCursor.data.markedCount, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1], 'no unread may be cleared while markRead is off');
  assert.equal((await request('wake-config', { body: { config: ACTIVE } })).status, 200);
  h.cfg.socialV2.tools.markRead = true;
  h.cfg.socialV2.tools.setWakeConfig = false;
  assert.equal((await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('an in-flight wait cannot authorize new messages after its session token is retired', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  append('before wait');
  const oldToken = st.agentToken;
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 }, token: oldToken });
  const timer = setTimeout(() => { h.retireSession(KEY); append('arrived after token retirement'); }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.notEqual(st.agentToken, oldToken);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 }, token: st.agentToken })).status, 400);
}, { observe: true });

await test('an in-flight wait cannot write observation into a replaced conversation state', async ({ h, st, request, append }) => {
  append('old state');
  const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
  const timer = setTimeout(() => {
    h.socialV2.conversations.delete(KEY);
    append('new conversation state');
  }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  const replacement = h.getSocialV2State(KEY);
  assert.equal(replacement.preSleepWaitSatisfiedAt, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 }, token: replacement.agentToken })).status, 400);
}, { observe: true });

await test('an in-flight wait rechecks mode permission before exposing a new arrival', async ({ h, request, append }) => {
  append('before mode change');
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 } });
  const timer = setTimeout(() => { h.setMode('chat'); h.retireSession(KEY); append('after mode change'); }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.equal(result.data.newMessages, undefined);
});

await test('building a budgeted snapshot preserves whole oldest messages without granting a receipt', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.wakeMessageLimit = 2;
  h.cfg.socialV2.context.wakeRecentLimit = 0;
  append('first'); append('second'); append('third');
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [1, 2]);
  assert.equal(snapshot.includedUnreadCount, 2);
  assert.equal(snapshot.unreadCount, 3);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 2);
  assert.ok(JSON.stringify(snapshot).length <= h.cfg.socialV2.context.wakeMaxChars);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
  assert.deepEqual(seqs(st.unread), [1, 2, 3]);
});

await test('an in-flight wait rechecks paused, feature, tool and allowlist permissions without granting observation', async ({ h, st, request, append }) => {
  append('unread before policy changes');
  const cases = [
    ['pause', () => { h.socialV2.paused = true; }, () => { h.socialV2.paused = false; }],
    ['feature disable', () => { h.cfg.socialV2.enabled = false; }, () => { h.cfg.socialV2.enabled = true; }],
    ['tool disable', () => { h.cfg.socialV2.tools.waitMessages = false; }, () => { h.cfg.socialV2.tools.waitMessages = true; }],
    ['allowlist removal', () => { h.cfg.allow.groups = []; }, () => { h.cfg.allow.groups = ['456']; }],
  ];
  // 记下当前状态，方便前后比对
  const before = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastReadThroughSeq: st.lastReadThroughSeq,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt });
  for (const [label, revoke, restore] of cases) {
    const snapshot = before();
    const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
    const timer = setTimeout(revoke, 60);
    let result;
    try { result = await waiting; } finally { clearTimeout(timer); restore(); }
    assert.equal(result.status, 403, label);
    assert.equal(result.data.newMessages, undefined, label);
    assert.deepEqual(before(), snapshot, `${label} cannot modify observation, unread or wake config`);
  }
}, { observe: true });

await test('oversized first stored unread remains intact and cannot be skipped by the snapshot', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.wakeMaxChars = 500;
  // 桥接存储只留开头和结尾的摘录
  // 两段长摘录会超过上限，不能再被截一次
  const long = '消息前半部分'.repeat(100) + '消息后半部分'.repeat(100);
  append(long); append('small but newer');
  const storedBefore = plain(st.unread[0]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 0);
  assert.ok(JSON.stringify(snapshot).length <= 500);
  assert.deepEqual(plain(st.unread[0]), storedBefore);
  const unread = await request('unread');
  assert.deepEqual(unread.data.messages[0], storedBefore);
});

await test('snapshot recent history stays chronological and does not duplicate unread', async ({ h, request, append }) => {
  append('history 1'); append('history 2'); append('history 3');
  await request('mark-read', { body: {} });
  append('current unread');
  h.cfg.socialV2.context.wakeRecentLimit = 2;
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [4]);
  assert.deepEqual(seqs(snapshot.recent), [2, 3]);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.readThroughSeq, 4);
});

await test('snapshot feature and tool flags cannot be bypassed through inline recent history', async ({ h, request, append }) => {
  append('authorized old history');
  await request('mark-read', { body: {} });
  append('unread requiring getUnread');
  h.cfg.socialV2.tools.getUnread = false;
  let snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.deepEqual(seqs(snapshot.recent), [1]);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 1);
  h.cfg.socialV2.tools.getRecent = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
  h.cfg.socialV2.tools.getUnread = true;
  snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [2]);
  assert.equal(snapshot.recent.length, 0);
  h.cfg.socialV2.context.inlineWakeMessages = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
});

await test('a compact image handle still resolves after unread outlives the recent buffer', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.recentLimit = 1;
  append('old unread image', { id: '900719925474099312345', media: [{ kind: 'image', file: 'fixture-kept-image' }] });
  append('newer text');
  assert.deepEqual(seqs(st.recentMessages), [2]);
  assert.deepEqual(seqs(st.unread), [1, 2]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages[0].media[0].index, 1);
  assert.equal(snapshot.messages[0].media[0].file, undefined);
  for (const messageId of ['1', '900719925474099312345']) {
    const result = await request('/api/agent/images/message', { query: `&messageId=${messageId}` });
    assert.equal(result.status, 200);
    assert.equal(result.data.media[0].file, 'fixture-kept-image');
    assert.equal(result.data.images[0].mimeType, 'image/png');
    assert.ok(result.data.images[0].data.length > 0, 'fixture gateway should return an actual image');
  }
  assert.deepEqual(h.calls.images, ['fixture-kept-image', 'fixture-kept-image']);
});

await test('busy and rate-limited wake attempts preserve the current observation state', async ({ h, st, append }) => {
  append('already observed');
  // 设几个观察用的值
  const setObservation = () => { st.preSleepWaitObservedAt = 123; st.preSleepWaitSatisfiedAt = 456; st.preSleepWaitAccumMs = 789; };
  // 检查观察用的值没被改动
  const checkObservation = () => assert.deepEqual([st.preSleepWaitObservedAt, st.preSleepWaitSatisfiedAt, st.preSleepWaitAccumMs], [123, 456, 789]);
  setObservation();
  h.promptQueues.set(KEY, { running: true, queue: [] });
  await h.sendWakePromptV2(KEY, 'question');
  checkObservation();
  h.promptQueues.delete(KEY);
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.wakeTimes = [Date.now()];
  await h.sendWakePromptV2(KEY, 'probability');
  checkObservation();
  assert.equal(h.calls.prompts.length, 0);
});

await test('a rejected prompt does not authorize the undelivered snapshot', async ({ h, st, request, append }) => {
  append('rejected snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('a new arrival during prompt acceptance is not implicitly part of the delivered snapshot', async ({ h, st, request, append }) => {
  append('snapshot message');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    append('arrived after snapshot construction');
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
  assert.equal((await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } })).status, 200);
  assert.deepEqual(seqs(st.unread), [2]);
});

await test('a retired prompt session cannot grant a receipt when its old acceptance returns', async ({ h, st, request, append }) => {
  append('retired snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    h.retireSession(KEY);
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal((await request('mark-read', { body: { throughSeq: 1 }, token: st.agentToken })).status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('offline wake replay builds a fresh snapshot with the current session token', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  const originalToken = st.agentToken;
  append('queued initial message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  h.retireSession(KEY);
  append('queued later message');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  const content = h.calls.prompts[0].content.map((part) => part.text || '').join('\n');
  assert.ok(content.includes('queued initial message'));
  assert.ok(content.includes('queued later message'));
  assert.ok(content.includes(st.agentToken));
  assert.ok(!content.includes(originalToken));
  assert.equal((await request('mark-read', { body: { throughSeq: 2 }, token: st.agentToken })).status, 200);
});

await test('offline reserved2 wake replay cannot leak into an ordinary chat session', async ({ h, append }) => {
  append('reserved2 queue message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  h.setMode('chat');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 0);
});

await test('real wake delivery inlines compact messages with exact quote and media handles', async ({ h, st, request, append }) => {
  append('fixture-inline-content', { id: '900719925474099312345',
    media: [{ kind: 'image', file: 'fixture-local-image', url: 'https://images.invalid/fixture-secret' }],
    forwards: ['fixture-forward-123'],
  });
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  const text = h.calls.prompts[0].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.ok(text.includes('fixture-inline-content'));
  assert.ok(text.includes('900719925474099312345'), 'quote ID must remain an exact string');
  assert.ok(text.includes('fixture-forward-123'), 'forward handle must remain fetchable');
  assert.ok(text.includes('readThroughSeq'));
  assert.ok(!text.includes('fixture-secret'), 'media URL is unnecessary when the local seq can resolve it');
  const close = await request('wake-config', { body: { config: ACTIVE, throughSeq: 1 } });
  assert.equal(close.status, 200, 'delivered inline content should authorize its cursor');
  assert.deepEqual(seqs(st.unread), []);
});

await test('oldest-first unread paging can drain a backlog beyond both recent and response limits', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 150;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 150; i++) append(`backlog ${i}`);
  const tail = await request('unread', { query: '&limit=100' });
  assert.equal(tail.data.messages[0].seq, 51, 'legacy tail ordering stays unchanged');
  assert.equal(tail.data.readThroughSeq, 0);
  const first = await request('unread', { query: '&limit=30&afterSeq=0' });
  assert.deepEqual(seqs(first.data.messages), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(first.data.readThroughSeq, 30);
  const next = await request('unread', { query: '&limit=30&afterSeq=30' });
  assert.equal(next.data.messages[0].seq, 31);
  assert.equal(next.data.readThroughSeq, 150, 'previous tail receipt now joins the complete prefix');
  append('arrived after complete read');
  assert.equal((await request('wake-config', { body: { config: ACTIVE, throughSeq: next.data.readThroughSeq } })).status, 200);
  assert.deepEqual(seqs(st.unread), [151]);
  for (const value of ['', '-1', '1.2', 'text', '9007199254740992']) {
    assert.equal((await request('unread', { query: `&afterSeq=${value}` })).status, 400);
  }
});

await test('offline queued wakes respect pause and disable at dispatch without exposing messages', async ({ h, st, append }) => {
  append('queued while active');
  for (const policy of ['paused', 'disabled']) {
    h.setReady(false);
    await h.sendWakePromptV2(KEY, 'question');
    if (policy === 'paused') h.socialV2.paused = true;
    else h.cfg.socialV2.enabled = false;
    h.setReady(true);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.deepEqual(seqs(st.unread), [1]);
    h.socialV2.paused = false;
    h.cfg.socialV2.enabled = true;
  }
});

await test('an evicted unread window cannot drag the acknowledged watermark back to zero', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 5;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 5; i++) append(`seen ${i}`);
  const read = await request('unread', { query: '&limit=5&afterSeq=0' });
  assert.equal(read.data.readThroughSeq, 5);
  assert.equal((await request('mark-read', { body: { throughSeq: 5 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 5, 'the acknowledged watermark is persisted');
  // 一次爆发把保留的未读窗口整个推到已读位置之上
  // 最早留着的序号不再是已读位置加一；它只是下限
  // 不能因为缓冲挤掉了证据，就把它报成 0
  for (let i = 6; i <= 11; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [7, 8, 9, 10, 11], 'older unread was evicted by unreadLimit');
  const after = await request('unread', { query: '&limit=5&afterSeq=5' });
  assert.ok(after.data.readThroughSeq >= 5, `watermark regressed to ${after.data.readThroughSeq}`);
  assert.equal(after.data.messages.length, 5, `afterSeq returned ${JSON.stringify(seqs(after.data.messages))}`);
  assert.equal(after.data.readThroughSeq, 11, `newly displayed messages must extend the watermark from its floor (got ${after.data.readThroughSeq})`);
  const again = await request('mark-read', { body: { throughSeq: 11 } });
  assert.equal(again.status, 200, 'a cursor earned by the model must stay acceptable after eviction');
  assert.deepEqual(seqs(st.unread), []);
});

await test('a plain query cannot lower the persisted watermark below what was already acknowledged', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 3;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  h.cfg.socialV2.wake.preSleepWaitEnabled = false; /* 把已读位置和睡前闸门隔开 */
  for (let i = 1; i <= 3; i++) append(`seen ${i}`);
  const first = await request('unread', { query: '&limit=3&afterSeq=0' });
  assert.equal(first.data.readThroughSeq, 3);
  assert.equal((await request('mark-read', { body: { throughSeq: 3 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 3);
  // 一次爆发会把证明已读位置的东西全挤掉；它只是下限
  // 之后的报告都必须从 3 开始，绝不能是 0
  for (let i = 4; i <= 6; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [4, 5, 6]);
  const state = h.getSocialV2State(KEY);
  const cached = await request('my-recent');
  assert.equal(cached.data.readThroughSeq, 3, `my-recent reported ${cached.data.readThroughSeq}, expected the floor 3`);
  const wake = await request('wake-config', { body: { config: ACTIVE } });
  assert.equal(wake.status, 200);
  assert.equal(wake.data.readThroughSeq, 3, `wake-config reported ${wake.data.readThroughSeq}, expected the floor 3`);
  assert.deepEqual(seqs(state.unread), [4, 5, 6], 'skip-free state: unread is untouched without a cursor');
});

await test('a displayed page extends the watermark across an eviction gap it can never show again', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 4;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  h.cfg.socialV2.wake.preSleepWaitEnabled = false;
  for (let i = 1; i <= 2; i++) append(`early ${i}`);
  const early = await request('unread', { query: '&limit=2&afterSeq=0' });
  assert.equal(early.data.readThroughSeq, 2);
  for (let i = 3; i <= 6; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [3, 4, 5, 6], 'nothing was evicted yet');
  // 序号 3 还挂着：不能因为后来翻了一页就认为它已读
  assert.equal((await request('mark-read', { body: { throughSeq: 4 } })).status, 400);
  assert.equal((await request('mark-read', { body: { throughSeq: 6 } })).status, 400);
  const page = await request('unread', { query: '&limit=2&afterSeq=2' });
  assert.deepEqual(seqs(page.data.messages), [3, 4]);
  assert.equal(page.data.messages.some((m) => m.seq === 3), true);
  // 3 和 4 都显示过，从下限 2 开始是连续的，位置是 4
  // 序号 5、6 继续挂着，不被这个位置清掉
  assert.equal(page.data.readThroughSeq, 4);
  assert.equal((await request('mark-read', { body: { throughSeq: 4 } })).status, 200);
  assert.deepEqual(seqs(st.unread), [5, 6]);
});

await test('message detail reports truncation instead of passing a preview off as the full text', async ({ h, st, request, append }) => {
  append('短消息');
  const short = await request('message-detail', { query: '&messageId=1' });
  assert.equal(short.status, 200);
  assert.equal(short.data.info.textTruncated, false, 'a short message is not truncated');
  // 桥接存储只留 200 字的首尾预览
  // 详情页显示的是同一份预览，要把这点说清楚
  append('长'.repeat(400));
  const long = await request('message-detail', { query: '&messageId=2' });
  assert.equal(long.status, 200);
  assert.equal(long.data.info.text.length, 200);
  assert.equal(long.data.info.textTruncated, true, 'a capped preview must be reported as truncated');
});

await test('N-01 message detail rechecks noContext and current member context policy', async ({ h, st, request, append }) => {
  append('local hidden detail', { id: '7101' });
  st.recentMessages[0].noContext = true;
  assert.equal((await request('message-detail', { query: '&messageId=1' })).status, 403);
  st.recentMessages[0].noContext = false;
  h.cfg.architecture.gateV2 = true;
  h.cfg.ignore.sendQQ = ['789'];
  assert.equal((await request('message-detail', { query: '&messageId=1' })).status, 403, 'current hard denial wins over old flags');
  assert.equal((await request('/api/console/scheduler/message-detail', { admin: true, query: '&messageId=1' })).status, 200, 'console remains unfiltered');
});

const detailPolicy = { config: { architecture: { gateV2: true } }, files: {
  'state/member-policy.json': JSON.stringify({ schemaVersion: 1, groups: { [KEY]: { mode: 'all', rules: {
    789: { flags: { context: true, memory: false } }, 790: { flags: { context: false } },
  } } } }),
} };
await test('N-01 detail permits memory=false in guarded windows but rejects recovered outside sources', async ({ h, st, request, append }) => {
  h.bot.getMessage = async () => ({ group_id: 456, user_id: 789, sender: { user_id: 789, nickname: 'fixture-person' }, message: [{ type: 'text', data: { text: 'gateway detail' } }] });
  append('retained memory=false detail', { id: '7102' });
  assert.equal((await request('message-detail', { query: '&messageId=1' })).status, 200);
  assert.equal((await request('message-detail', { query: '&messageId=7102' })).status, 200);
  st.recentMessages = [];
  assert.equal((await request('message-detail', { query: '&messageId=1' })).status, 200, 'unread also belongs to guarded window');
  st.unread = [];
  assert.equal((await request('message-detail', { query: '&messageId=7103' })).status, 403);
  h.bot.getMessage = async () => ({ group_id: 456, user_id: 790, sender: { user_id: 790 }, message: [{ type: 'text', data: { text: 'hidden context' } }] });
  assert.equal((await request('message-detail', { query: '&messageId=7104' })).status, 403, 'gateway result must obey current context flag');
  append('stale context marker', { id: '7105' });
  st.recentMessages[0].userId = '790';
  assert.equal((await request('message-detail', { query: '&messageId=2' })).status, 403, 'current context=false overrides stored noContext=false');
}, detailPolicy);

await test('N-02/F-14 unread and wake snapshot filter before paging without mutating backlog', async ({ h, st, request, append }) => {
  append('hidden first'); append('visible'); append('hidden last');
  st.unread[0].noContext = true;
  st.unread[2].noContext = true;
  const before = plain(st.unread);
  for (const query of ['&limit=1', '&afterSeq=0&limit=1']) {
    const result = await request('unread', { query });
    assert.deepEqual(seqs(result.data.messages), [2]);
    assert.equal(result.data.unreadCount, 1, 'agent only observes visible unread count');
    assert.equal(result.data.readThroughSeq, 3, 'hidden unread is safely skippable around displayed seq2');
    assert.equal(st.modelSeenSeqs.has(1), false, 'skipping hidden is not a model exposure receipt');
    assert.equal(st.modelSeenSeqs.has(3), false);
  }
  h.cfg.socialV2.context.wakeMessageLimit = 1;
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [2], 'F-14：先过滤再占快照预算');
  assert.equal(snapshot.unreadCount, 1);
  assert.equal(snapshot.includedUnreadCount, 1);
  assert.equal(snapshot.partial, false, 'only hidden messages remain');
  assert.equal(snapshot.readThroughSeq, 3);
  assert.deepEqual(seqs((await request('unread', { admin: true })).data.messages), [1, 2, 3]);
  assert.deepEqual(plain(st.unread), before);
  const marked = await request('mark-read', { body: { throughSeq: 3 } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 3);
  assert.deepEqual(seqs(st.unread), []);
});

await test('C-06 / R-07 agent state, prompt and participation hide noContext message counts while console keeps raw counts', async ({ h, st, request, append }) => {
  append('hidden one');
  append('visible two');
  st.unread[0].noContext = true;
  st.recentMessages[0].noContext = true;
  const stateRes = await request('state');
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.data.unreadCount, 1);
  assert.equal(stateRes.data.recentCount, 1);
  const promptRes = await request('prompt');
  assert.equal(promptRes.status, 200);
  assert.equal(promptRes.data.unreadCount, 1);
  assert.equal(promptRes.data.recentCount, 1);
  assert.match(promptRes.data.participation, /群友发言 1 条/, 'participation 不得计数隐藏成员消息');
  const adminUnread = await request('unread', { admin: true });
  assert.equal(adminUnread.data.unreadCount, 2, '控制台视图保留全量未读计数');
});

await test('R-03 historical reads recheck context and hard denial without mutating stored messages', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('formerly visible source');
  const before = plain(st.unread);
  const setFlags = flags => {
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [KEY]: { mode: 'all', rules: { 789: { flags } } } } }));
    h.loadMemberPolicy();
  };
  for (const policy of ['context', 'hard-denial']) {
    if (policy === 'context') setFlags({ context: false, memory: true });
    else { setFlags({ context: true }); h.cfg.ignore.sendQQ = ['789']; }
    for (const route of ['unread', 'recent']) {
      const result = await request(route);
      assert.equal(result.status, 200);
      assert.deepEqual(seqs(result.data.messages), [], `${route}/${policy}`);
      assert.equal(result.data.readThroughSeq, 1, 'currently hidden source is safely skippable');
    }
    assert.deepEqual(seqs(h.buildWakeSnapshotV2(KEY).messages), []);
    const prompt = h.buildWakePromptV2(KEY, 'timeout');
    assert.ok(!prompt.includes('formerly visible source'), policy);
    assert.ok(!prompt.includes('fixture-person'), 'time sense and status cannot leak hidden actor');
    assert.equal((await request('active-members')).data.members.length, 0);
    assert.deepEqual(seqs((await request('unread', { admin: true })).data.messages), [1]);
    assert.deepEqual(plain(st.unread), before);
  }
  h.cfg.ignore.sendQQ = [];
  setFlags({ context: true, memory: false });
  assert.deepEqual(seqs((await request('unread')).data.messages), [1], 'memory=false alone is not a read prohibition');
});

await test('R-04 hidden skip cannot bridge an unshown visible hole or become a permanent receipt', async ({ st, request, append }) => {
  append('hidden first'); append('visible unseen hole'); append('visible shown tail');
  st.unread[0].noContext = true;
  const tail = await request('unread', { query: '&limit=1' });
  assert.deepEqual(seqs(tail.data.messages), [3]);
  assert.equal(tail.data.readThroughSeq, 1);
  assert.equal((await request('mark-read', { body: { throughSeq: 3 } })).status, 400);
  st.unread[0].noContext = false;
  assert.equal((await request('my-recent')).data.readThroughSeq, 0, 'unacknowledged skip must be recalculated after visibility returns');
  assert.equal(st.modelSeenSeqs.has(1), false);
  assert.deepEqual(seqs(st.unread), [1, 2, 3]);
});

await test('R-03 v1 context and batch builders filter current policy before budgeting and retain exposed sources', async () => {
  let hidden = false;
  const state = {};
  const messages = [
    { userId: '123', messageId: 'public', sender: 'visible-person', text: 'public-text' },
    { userId: '789', messageId: 'secret', sender: 'hidden-person', text: 'hidden-text', media: [{ kind: 'image', file: 'secret-image' }] },
  ];
  const b = { cfg: { architecture: { gateV2: true }, social: { contextWindow: 1 } },
    social: { recentMessages: new Map([[KEY, messages]]) },
    gateDecide: ({ qq }) => ({ allowed: true, flags: { context: !(hidden && qq === '789') } }),
    getSocialV2State: () => state, saveSocialV2State: () => true,
    sanitizeUntrustedText: text => text, mediaHintFor: () => '',
  };
  Object.assign(b, createSocialStateMachineV1(b), createSocialPromptsV1(b));
  assert.ok(b.buildContextBlock(KEY).includes('hidden-text'));
  assert.deepEqual(state.modelSourceQqs, ['789'], 'prebuilt context records source before rolling-window eviction');
  hidden = true;
  const context = b.buildContextBlock(KEY);
  assert.ok(context.includes('public-text'), 'filter before contextWindow limit');
  assert.ok(!context.includes('hidden-text'));
  const batch = b.buildBatchPrompt(KEY, messages);
  assert.ok(batch.includes('public-text'));
  assert.ok(!batch.includes('hidden-text'));
  assert.deepEqual(state.modelSourceQqs, ['123', '789'], 'previously exposed restricted source cannot be forgotten');
});

await test('R-03 v1 summary flush rechecks context and media while retaining actors across recent eviction', async () => {
  const state = {};
  const deliveries = [];
  const b = { cfg: { architecture: { gateV2: true } },
    social: { recentMessages: new Map(), pendingSummaries: new Map() },
    gateDecide: ({ qq }) => ({ allowed: qq !== '790', flags: { context: qq !== '789', memory: true } }),
    getSocialV2State: () => state, saveSocialV2State: () => true,
    sanitizeUntrustedText: text => text, mediaHintFor: () => '', currentRoleHint: () => '', log() {},
    deliverPrompt: async (key, text, opts) => { deliveries.push({ key, text, opts }); return { ok: true }; },
  };
  Object.assign(b, createSocialStateMachineV1(b), createSocialLoopV1(b));
  for (const qq of ['123', '789', '790']) {
    b.appendRecentMessage(KEY, `person-${qq}`, `text-${qq}`, '', false, false, [], `message-${qq}`, { userId: qq });
    b.appendSummary(KEY, `person-${qq}`, `text-${qq}`, '', false, [{ kind: 'image', file: `media-${qq}` }], `message-${qq}`);
  }
  b.social.recentMessages.set(KEY, []);
  await b.flushSummaries(KEY);
  assert.equal(deliveries.length, 1);
  assert.ok(deliveries[0].text.includes('text-123'));
  assert.ok(!deliveries[0].text.includes('text-789'));
  assert.ok(!deliveries[0].text.includes('text-790'));
  assert.deepEqual(deliveries[0].opts.media.map(item => item.file), ['media-123']);
  assert.deepEqual(state.modelSourceQqs, ['123']);
  b.appendSummary(KEY, 'unknown', 'unattributed-history', '', false, [], 'unknown-id');
  await b.flushSummaries(KEY);
  assert.equal(deliveries.length, 1, 'unknown historical actors fail closed with gateV2');
});

await test('R-03 v1 active batches exclude newly hidden and silent-context media before scheduling', async () => {
  const state = {};
  const scheduled = [];
  const msg = qq => ({ userId: qq, sender: `person-${qq}`, text: `text-${qq}`, time: 10, media: [{ kind: 'image', file: `media-${qq}` }] });
  const b = { cfg: { architecture: { gateV2: true }, social: { skipProbability: 0 } },
    social: { states: new Map([[KEY, { phase: 'active', nextCheckAt: 0, lastCheckAt: 1 }]]),
      recentMessages: new Map([[KEY, [msg('123'), msg('789')]]]), silentContext: new Map([[KEY, [msg('790')]]]) },
    modeForKey: () => 'reserved', isSessionAllowedInCurrentMode: () => true,
    gateDecide: ({ qq }) => ({ allowed: true, flags: { context: qq === '123' } }),
    getSocialV2State: () => state, saveSocialV2State: () => true,
    sanitizeUntrustedText: text => text, mediaHintFor: () => '', triggerActiveDurationExit: () => false,
    schedulerEnabled: () => true, log() {},
    scheduleDelayedPrompt: async (key, text, opts) => { scheduled.push({ key, text, opts }); },
  };
  Object.assign(b, createSocialStateMachineV1(b), createSocialPromptsV1(b), createSocialLoopV1(b));
  b.socialLoopTick(KEY);
  assert.equal(scheduled.length, 1);
  assert.ok(!scheduled[0].text.includes('text-789'));
  assert.ok(!scheduled[0].text.includes('text-790'));
  assert.deepEqual(scheduled[0].opts.media.map(item => item.file), ['media-123']);
});

await test('R-03 forward reads retain root visibility for cached nested IDs and media', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('forward root', { forwards: ['policy-root'] });
  const image = { kind: 'image', file: 'policy-forward-image' };
  h.bot.raw = async (action, { id }) => ({ messages: [{ sender: { user_id: 123, nickname: 'node' }, content:
    id === 'policy-root' ? [{ type: 'forward', data: { id: 'policy-child' } }, { type: 'image', data: { file: image.file } }]
      : [{ type: 'text', data: { text: 'nested body' } }] }] });
  assert.equal((await request('forward-message', { query: '&id=policy-root' })).status, 200);
  st.recentMessages = []; st.unread = [];
  h.cfg.ignore.sendQQ = ['789'];
  const child = await request('forward-message', { query: '&id=policy-child' });
  assert.equal(child.status, 403, 'cached nested forward must retain its original actor restriction');
  assert.equal((await request('forward-media', { body: { media: [image] } })).status, 403);
});

await test('R-03 quoted historical authors are rechecked through sourceQqs independently of the sender', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('visible sender quoting restricted original');
  st.unread[0].sourceQqs = ['789', '790'];
  h.cfg.ignore.sendQQ = ['790'];
  assert.deepEqual(seqs((await request('unread')).data.messages), []);
  assert.deepEqual(seqs((await request('recent')).data.messages), []);
  assert.deepEqual(seqs(h.buildWakeSnapshotV2(KEY).messages), []);
  assert.equal((await request('message-detail', { query: '&messageId=1' })).status, 403);
  assert.ok(!h.buildWakePromptV2(KEY, 'timeout').includes('visible sender quoting'));
});

await test('R-03 wait filters current hidden history before receipts and capacity', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('visible pending');
  append('hidden by current context');
  st.unread[1].sourceQqs = ['789', '790'];
  h.cfg.ignore.sendQQ = ['790'];
  const result = await request('wait', { body: { purpose: 'reply', timeoutMs: 100, quietMs: 0 } });
  assert.equal(result.status, 200);
  assert.deepEqual(seqs(result.data.newMessages), [1]);
  assert.equal(st.modelSeenSeqs.has(2), false, 'hidden skip must not become a receipt');
  assert.equal(result.data.readThroughSeq, 2);
});

await test('R-03 reply wait fallback cannot infer unfinished text from hidden history', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('visible complete。');
  await request('unread');
  append('hidden，');
  st.unread[1].sourceQqs = ['789', '790'];
  h.cfg.ignore.sendQQ = ['790'];
  const result = await request('wait', { body: { purpose: 'reply', timeoutMs: 100, quietMs: 0 } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.lastMessageUnfinished, false);
  assert.equal(st.modelSeenSeqs.has(2), false);
});

await test('R-03 images reject dynamically hidden sources before fetching cached media', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('image source', { id: '8301', media: [{ kind: 'image', file: 'policy-image' }] });
  const message = st.unread[0];
  for (const restriction of ['context', 'noContext', 'sourceQqs']) {
    message.noContext = restriction === 'noContext';
    message.sourceQqs = restriction === 'sourceQqs' ? ['789', '790'] : [];
    h.cfg.ignore.sendQQ = restriction === 'sourceQqs' ? ['790'] : [];
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [KEY]: { mode: 'all', rules: {
      789: { flags: { context: restriction !== 'context', memory: true } },
    } } } }));
    h.loadMemberPolicy();
    const result = await request('/api/agent/images/message', { query: '&messageId=8301' });
    assert.equal(result.status, 403, restriction);
    assert.equal(result.data.images, undefined);
  }
  assert.deepEqual(h.calls.images, [], 'must not fetch a forbidden source');
});

await test('R-03 images recheck source restrictions after asynchronous fetch', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('async image', { id: '8302', media: [{ kind: 'image', file: 'async-policy-image' }] });
  const original = h.bot.getImage.bind(h.bot);
  const message = st.unread[0];
  for (const restriction of ['context', 'noContext', 'sourceQqs', 'eviction']) {
    message.noContext = false; message.sourceQqs = [];
    h.cfg.ignore.sendQQ = [];
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: {} }));
    h.loadMemberPolicy();
    h.bot.getImage = async params => {
      const result = await original(params);
      if (restriction === 'context') {
        fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [KEY]: { mode: 'all', rules: { 789: { flags: { context: false } } } } } }));
        h.loadMemberPolicy();
      } else if (restriction === 'noContext') message.noContext = true;
      else if (restriction === 'sourceQqs') { message.sourceQqs = ['789', '790']; h.cfg.ignore.sendQQ = ['790']; }
      else { st.recentMessages = []; st.unread = []; }
      return result;
    };
    const result = await request('/api/agent/images/message', { query: '&messageId=8302' });
    assert.equal(result.status, 403, restriction);
    assert.equal(result.data.images, undefined);
    assert.deepEqual(st.modelSourceQqs ?? [], [], 'denied media must not be exposed or tracked as seen');
  }
});

await test('R-03 visible images persist all model sources before window eviction', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('visible memory-restricted image', { id: '8303', media: [{ kind: 'image', file: 'tracked-policy-image' }] });
  st.unread[0].sourceQqs = ['789', '791'];
  // Exercise the real route without the HTTP wrapper's rolling-window union.
  const route = createToolSendRoutes({ ...h, agentTokenOk: () => true, v2ToolEnabled: () => true,
    gateDecide: () => ({ allowed: true, flags: { context: true } }),
    findMessageMedia: () => st.unread[0].media, log() {},
  });
  let result;
  await route({ req: { method: 'GET', headers: { 'x-agent-token': st.agentToken } }, toolPolicy: true,
    url: new URL(`http://fixture.invalid/api/agent/images/message?key=${KEY}&messageId=1`),
    sendJson: (data, status = 200) => { result = { status, data }; },
  });
  assert.equal(result.status, 200);
  assert.ok(result.data.images[0].data.length > 0);
  assert.deepEqual(st.modelSourceQqs, ['789', '791'], 'image response has no userId for the generic wrapper to collect');
  st.recentMessages = []; st.unread = [];
  const write = await request('memory-append', { body: { category: 'event', content: 'derived from old image' } });
  assert.equal(write.status, 403, 'memory=false actor must remain guarded after eviction');
}, detailPolicy);

for (const endpoint of ['images', 'message-detail']) {
  await test(`P2 in-flight ${endpoint} rechecks live permissions before exposure or tracking`, async ({ h, st, request, append }) => {
    append('permission-guarded image', { id: '8330', media: [{ kind: 'image', file: 'permission-image' }] });
    const originalImage = h.bot.getImage.bind(h.bot);
    const flag = endpoint === 'images' ? 'getImages' : 'getMessageDetail';
    const cases = [
      ['paused', () => { h.socialV2.paused = true; }, () => { h.socialV2.paused = false; }],
      ['disabled', () => { h.cfg.socialV2.enabled = false; }, () => { h.cfg.socialV2.enabled = true; }],
      ['tool', () => { h.cfg.socialV2.tools[flag] = false; }, () => { h.cfg.socialV2.tools[flag] = true; }],
      ['allowlist', () => { h.cfg.allow.groups = []; }, () => { h.cfg.allow.groups = ['456']; }],
      ['mode', () => { h.setMode('chat'); }, () => { h.setMode('reserved2'); }],
    ];
    for (const [index, [label, revoke, restore]] of cases.entries()) {
      h.bot.getImage = async params => { const result = await originalImage(params); revoke(); return result; };
      h.bot.getMessage = async () => {
        revoke();
        return { group_id: 456, user_id: 789, sender: { user_id: 789 }, message: [{ type: 'text', data: { text: 'permission secret' } }] };
      };
      let result;
      try {
        result = endpoint === 'images'
          ? await request('/api/agent/images/message', { query: '&messageId=8330' })
          : await request('message-detail', { query: `&messageId=${8340 + index}` });
      } finally { restore(); }
      assert.equal(result.status, 403, label);
      assert.equal(result.data.images, undefined, label);
      assert.equal(result.data.info, undefined, label);
      assert.deepEqual(st.modelSourceQqs ?? [], [], `${label}: denied sources must not be recorded`);
    }
  });
}

await test('P2 response guard preserves unbound status and console detail across retirement', async ({ h, st, request }) => {
  h.bot.getMessage = async () => {
    h.retireSession(KEY, { preserveQueue: true });
    return { group_id: 456, user_id: 789, sender: { user_id: 789 }, message: [{ type: 'text', data: { text: 'console-only detail' } }] };
  };
  const detail = await request('message-detail', { admin: true, query: '&messageId=8350' });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.info.text, 'console-only detail');
  assert.deepEqual(st.modelSourceQqs ?? [], []);
  h.socialV2.paused = true;
  h.cfg.socialV2.enabled = false;
  assert.equal((await request('status', { unbound: true })).status, 200);
  assert.equal((await request('/api/console/status', { admin: true })).status, 200);
});

await test('P2 in-flight message detail rejects real in-place token retirement without tracking returned sources', async ({ h, st, request }) => {
  await h.ensureSession(KEY);
  const oldToken = st.agentToken;
  h.bot.getMessage = async () => {
    h.retireSession(KEY, { preserveQueue: true });
    assert.equal(h.getSocialV2State(KEY), st);
    assert.notEqual(st.agentToken, oldToken);
    return { group_id: 456, user_id: 789, sender: { user_id: 789, nickname: 'retired-source' },
      message: [{ type: 'text', data: { text: 'retired detail secret' } }] };
  };
  const result = await request('message-detail', { token: oldToken, query: '&messageId=8320' });
  assert.equal(result.status, 403, 'central response guard must reject a revoked token after gateway I/O');
  assert.equal(result.data.info, undefined);
  assert.ok(!JSON.stringify(result.data).includes('retired detail secret'));
  assert.deepEqual(st.modelSourceQqs ?? [], [], 'do not register sources from a denied detail response');
  assert.equal((await request('message-detail', { token: oldToken, query: '&messageId=8320' })).status, 403);
});

await test('P2 in-flight images reject real in-place token retirement before exposure or source tracking', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  append('retiring image', { id: '8310', media: [{ kind: 'image', file: 'retiring-policy-image' }] });
  const oldToken = st.agentToken;
  const epoch = h.conversationEpoch(KEY);
  const original = h.bot.getImage.bind(h.bot);
  h.bot.getImage = async params => {
    const result = await original(params);
    h.retireSession(KEY, { preserveQueue: true });
    assert.equal(h.getSocialV2State(KEY), st, 'real retirement must keep the same state object');
    assert.notEqual(st.agentToken, oldToken);
    assert.notEqual(h.conversationEpoch(KEY), epoch);
    return result;
  };
  const result = await request('/api/agent/images/message', { token: oldToken, query: '&messageId=8310' });
  assert.equal(result.status, 403, 'an already revoked in-flight token must not receive image bytes');
  assert.equal(result.data.images, undefined);
  assert.equal(result.data.media, undefined);
  assert.deepEqual(st.modelSourceQqs ?? [], [], 'denied media must not register its actors');
  assert.deepEqual(h.calls.images, ['retiring-policy-image'], 'retire during the real image fetch');
  assert.equal((await request('/api/agent/images/message', { token: oldToken, query: '&messageId=8310' })).status, 403);
});

await test('R-03 image reads cannot expose an obsolete session after fetch', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('obsolete image', { id: '8304', media: [{ kind: 'image', file: 'obsolete-policy-image' }] });
  const original = h.bot.getImage.bind(h.bot);
  h.bot.getImage = async params => {
    const result = await original(params);
    h.socialV2.conversations.delete(KEY);
    h.getSocialV2State(KEY);
    return result;
  };
  const result = await request('/api/agent/images/message', { query: '&messageId=8304' });
  assert.equal(result.status, 403);
  assert.equal(result.data.images, undefined);
  assert.deepEqual(st.modelSourceQqs ?? [], []);
});

await test('R-03 images fail closed for cache-only unknown sources with gateV2', async ({ h, st, request, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('evicted cached image', { id: '8305', media: [{ kind: 'image', file: 'cache-only-policy-image' }] });
  st.recentMessages = []; st.unread = [];
  const result = await request('/api/agent/images/message', { query: '&messageId=8305' });
  assert.equal(result.status, 403);
  assert.equal(result.data.media, undefined);
  assert.deepEqual(h.calls.images, []);
});

await test('R-03 current-input exception preserves sender plain but never restricted quoted history', async ({ h, st, append }) => {
  h.cfg.architecture.gateV2 = true;
  append('quoted-private-history\ncurrent-sender-input');
  const message = st.unread[0];
  message.userId = '790'; message.sourceQqs = ['790', '789'];
  message.plain = 'current-sender-input';
  message.tail = message.plain;
  const before = plain(message);
  for (const senderContext of [true, false]) {
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [KEY]: { mode: 'all', rules: {
      789: { flags: { context: false } }, 790: { flags: { context: senderContext, respond: true } },
    } } } }));
    h.loadMemberPolicy();
    for (const reason of ['at@seq1', 'bootstrap']) {
      const prompt = h.buildWakePromptV2(KEY, reason);
      assert.ok(prompt.includes('current-sender-input'), `${reason}/${senderContext}: retain current input`);
      assert.ok(!prompt.includes('quoted-private-history'), `${reason}/${senderContext}: do not restore restricted quote`);
    }
  }
  assert.deepEqual(plain(message), before, 'projection must not rewrite persisted history');
});

for (const reason of ['bootstrap', 'atMention@seq1']) {
  await test(`R-03 real ${reason} delivery cannot restore hard-denied quoted history`, async ({ h, st, append }) => {
    h.cfg.architecture.gateV2 = true;
    append('hard-denied-quote-secret\ncurrent-input-public');
    st.unread[0].plain = 'current-input-public';
    st.unread[0].tail = 'current-input-public';
    st.unread[0].sourceQqs = ['789', '790'];
    h.cfg.ignore.sendQQ = ['790'];
    assert.deepEqual(h.buildWakeSnapshotV2(KEY).messages, []);
    assert.ok(!h.buildWakePromptV2(KEY, 'timeout').includes('hard-denied-quote-secret'));
    await h.sendWakePromptV2(KEY, reason);
    assert.equal(h.calls.prompts.length, 1, 'must exercise real prompt delivery');
    const delivered = JSON.stringify(h.calls.prompts[0]);
    assert.ok(delivered.includes('current-input-public'), 'current sender input remains available');
    assert.ok(!delivered.includes('hard-denied-quote-secret'), 'hard-denied quote never reaches DSH');
  });
}

await test('F-36 memory HTTP preserves policy 403 for term and alias', async ({ request, append }) => {
  append('restricted memory source');
  for (const category of ['term', 'alias']) {
    const response = await request('/api/console/memory/append', { admin: true, body: { category, content: 'fixture-name', extra: { target: '789' } } });
    assert.equal(response.status, 403, `${category}: ${JSON.stringify(response.data)}`);
  }
}, detailPolicy);

await test('F-35/N-06/F-36 corrupt impression targets return validation 400 before identity or policy', async ({ st, request, append }) => {
  append('restricted memory source');
  st.memberImpressions = JSON.parse('{"__proto__":{"displayName":"__proto__","traits":[]}}');
  for (const target of ['__proto__', 'constructor', 'prototype']) {
    for (const route of ['memory-append', 'memory-update']) {
      const response = await request(`/api/console/memory/${route.slice(7)}`, { admin: true, body: { category: 'memberImpression', content: 'fixture', newContent: 'fixture', target, extra: { target } } });
      assert.equal(response.status, 400, `${route}/${target}: ${JSON.stringify(response.data)}`);
      assert.match(response.data.error, /非法的群友名字/);
    }
  }
}, detailPolicy);

console.log(`\nToken economy bridge regressions: ${tests - failures}/${tests} passed.`);
if (failures) process.exitCode = 1;
