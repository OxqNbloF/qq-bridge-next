// 阶段 3（P2）协议、调度、HTTP/配置并发、FFmpeg 与运维脚本可靠性回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenHeal } from '../src/gateway/token-heal.js';
import { createUpstreamHealth } from '../src/gateway/upstream-health.js';
import { NodeApiClient } from '../src/dsh-client.js';
import { withConfigWriteLock } from '../src/infra/config.js';
import { createDeliveryCursors } from '../src/store/delivery-cursors.js';
import { createPendingQuestions } from '../src/conversations/pending.js';
import { createDeduper } from '../src/pipeline/dedupe.js';
import { buildEnvelope } from '../src/pipeline/envelope.js';
import { createRecallHandler } from '../src/inbound/recall.js';
import { createSocialLoopV1 } from '../src/features/simulation-v1/loop.js';
import { createSocialStateMachineV1 } from '../src/features/simulation-v1/state-machine.js';
import { isBridgeProcess, isGuardProcess, parsePsTable } from '../scripts/stop-bridge-instance.mjs';
import { parseVoiceCliArgs } from '../scripts/send-voice.mjs';
import { hardenDir, hardenFile, isHardened, manualDirCommand } from '../src/state-acl.mjs';
import { parseBingHtml } from '../src/web-search.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test('token-heal: healTokenIfStale 单飞锁 + reconnectBot 吞掉异步拒绝', async () => {
  let probeCalls = 0;
  let connectCalls = 0;
  const bot = {
    close() {},
    async connect() {
      connectCalls += 1;
      throw new Error('simulated ws failure');
    },
  };
  const cfg = { snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'old' } };
  const healer = createTokenHeal({
    cfg,
    bot,
    configFile: path.join(os.tmpdir(), 'dummy-config.json'),
    log() {},
    discoverSnowLumaConnection: async () => {
      probeCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, token: 'new-http-tok', wsToken: 'new-ws-tok', wsUrl: 'ws://127.0.0.1:3001', baseUrl: 'http://127.0.0.1:3000', via: 'probe' };
    },
    persistSnowLumaEndpoint: () => ({ updated: false, changed: {} }),
    persistToken: () => ({ updated: false }),
  });
  await Promise.all([healer.healTokenIfStale('auth'), healer.healTokenIfStale('auth')]);
  assert.equal(probeCalls, 1, '并发触发自愈应合并为单次 probe');
  assert.equal(cfg.snowluma.accessToken, 'new-http-tok');
  await new Promise((r) => setTimeout(r, 380));
  assert.ok(connectCalls >= 1, 'reconnectBot 应尝试重连且不触发未处理拒绝');
});

await test('upstream-health: 未建连前 connected=false 且不误报 silent', async () => {
  const health = createUpstreamHealth({
    cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000' } },
    log() {},
    fetch: async () => ({ ok: false, status: 503 }),
    timers: { setTimeout, setInterval, clearInterval },
  });
  const snap = health.snowlumaHealthSnapshot();
  assert.equal(snap.connected, false);
  assert.equal(snap.silent, false);
});

await test('dsh-client: rebind 中断活跃 mux 且 invalidateAuth 保留显式 token', async () => {
  const client = new NodeApiClient('http://127.0.0.1:3080', undefined, { token: 'explicit-tok', tokenExplicit: true });
  let aborted = 0;
  client._activeMuxAbort = () => { aborted += 1; };
  client.rebind('http://127.0.0.1:3090');
  assert.equal(aborted, 1, 'rebind 应主动中止活跃 mux');
  assert.equal(client.baseUrl, 'http://127.0.0.1:3090');
  client.invalidateAuth();
  assert.equal(client.launchToken, 'explicit-tok', '显式配置的 token 不应被 invalidateAuth 覆盖或清空');
});

await test('web-search: parseBingHtml 先剥标签再解码实体，不误删字面 <tag>', async () => {
  const html = '<li class="b_algo"><h2><a href="https://example.com/a">std::vector&lt;int&gt;</a></h2><p>使用 &lt;div&gt; 和 <b>粗体</b> &amp; &lt;script&gt;</p></li>';
  const rows = parseBingHtml(html, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'std::vector<int>');
  assert.ok(rows[0].snippet.includes('<div>'), `应保留字面 <div>，实际: ${rows[0].snippet}`);
  assert.ok(rows[0].snippet.includes('<script>'), `应保留字面 <script>，实际: ${rows[0].snippet}`);
  assert.ok(rows[0].snippet.includes('粗体'));
});

await test('config: withConfigWriteLock 严格串行化并发写入', async () => {
  const order = [];
  const p1 = withConfigWriteLock(async () => {
    order.push('start-1');
    await new Promise((r) => setTimeout(r, 30));
    order.push('end-1');
    return 1;
  });
  const p2 = withConfigWriteLock(async () => {
    order.push('start-2');
    order.push('end-2');
    return 2;
  });
  const res = await Promise.all([p1, p2]);
  assert.deepEqual(res, [1, 2]);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

await test('delivery-cursors: modeKnown=false 时空快照也入队并在 replayDeferredDeliveries 触发 reconcile', async () => {
  const reconciled = [];
  const b = {
    modeKnown: false,
    reverse: new Map([['s-empty', 'group:123']]),
    DELIVERY_CURSOR_FILE: path.join(os.tmpdir(), `dc-${Date.now()}.json`),
    log() {},
    recordSessionSnapshot() {},
    prepareScheduledSnapshot() {},
    reconcileScheduledSnapshot(sid, records) { reconciled.push([sid, records]); },
    modeForKey: () => 'reserved2',
    isCurrentSession: () => true,
  };
  const dc = createDeliveryCursors(b);
  await dc.handleSessionSnapshot('s-empty', { records: [] });
  assert.equal(dc.pendingDeliveryReplays.has('s-empty'), true);
  b.modeKnown = true;
  await dc.replayDeferredDeliveries();
  assert.deepEqual(reconciled, [['s-empty', []]]);
});

await test('pending: handlePendingAnswer 防并发重复回执、清定时器并返回 true', async () => {
  let respondCalls = 0;
  let clearedTimer = null;
  const b = {
    pending: new Map(),
    cfg: { questionTimeoutMs: 60000 },
    APPROVE_WORDS: ['通过'],
    REJECT_WORDS: ['拒绝'],
    api: {
      async respond() {
        respondCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return { ok: true };
      },
    },
    withTimeout: (p) => p,
    setTimeout,
    clearTimeout: (t) => { clearedTimer = t; clearTimeout(t); },
    log() {},
    sendToQQ: async () => {},
  };
  const pq = createPendingQuestions(b);
  const entry = { kind: 'approval', clientId: 'c1', eventId: 'e1' };
  await pq.registerPending('group:1', entry);
  const timerRef = entry.timer;
  const [r1, r2] = await Promise.all([
    pq.handlePendingAnswer(entry, '通过', 'group:1', true),
    pq.handlePendingAnswer(entry, '通过', 'group:1', true),
  ]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(respondCalls, 1, '并发回答只应调用一次 api.respond');
  assert.equal(clearedTimer, timerRef, '回执成功后应清理超时定时器');
  assert.equal(b.pending.has('group:1'), false);
});

await test('pipeline: dedupe 按 maxConvs 淘汰旧会话 + envelope 记忆化 resolveAtName', async () => {
  const deduper = createDeduper({ max: 10, maxConvs: 2 });
  assert.equal(deduper.seen('c1', 'm1'), false);
  assert.equal(deduper.seen('c2', 'm1'), false);
  assert.equal(deduper.seen('c3', 'm1'), false);
  // c1 应已被淘汰，再次出现视为未见过
  assert.equal(deduper.seen('c1', 'm1'), false);
  assert.equal(deduper.forget('c1', 'm1'), true);

  let atCalls = 0;
  const env = await buildEnvelope('group', {
    group_id: 456, user_id: 123, message_id: 99,
    sender: { nickname: 'Alice' },
    message: [{ type: 'at', data: { qq: '789' } }, { type: 'text', data: { text: ' hello' } }],
  }, {
    resolveAtName: async (qq) => { atCalls += 1; return `User${qq}`; },
  });
  assert.equal(atCalls, 1, 'text 与 plain 应共用同一次 resolveAtName 解析结果');
  assert.ok(env.text.includes('@User789'));
});

await test('recall: 精准删除被撤回消息缓存（不误伤同会话其它缓存）且清理一代缓冲', async () => {
  const replyInfoCache = new Map([
    ['group:456:100', { text: 'recalled' }],
    ['group:456:200', { text: 'keep-me' }],
  ]);
  const v1Recent = new Map([['group:456', [{ messageId: '100', text: 'secret', plain: 'secret' }]]]);
  const b = {
    convKey: (k, id) => `${k}:${id}`,
    archiveSafely() {},
    socialV2: { conversations: new Map() },
    social: { recentMessages: v1Recent, pendingSummaries: new Map(), silentContext: new Map() },
    replyInfoCache,
    messageMediaStore: new Map(),
    seenForwardIds: new Map(),
    saveSocialV2State() {},
    log() {},
  };
  const { handleRecallNotice } = createRecallHandler(b);
  const ok = handleRecallNotice({ notice_type: 'group_recall', group_id: 456, message_id: 100 });
  assert.equal(ok, true);
  assert.equal(replyInfoCache.has('group:456:100'), false);
  assert.equal(replyInfoCache.has('group:456:200'), true, '同会话未撤回消息的引用缓存不应被清空');
  assert.equal(v1Recent.get('group:456')[0].text, '[该消息已被撤回]');
});

await test('sim-v1: flushSummaries 仅移除已快照条数 + isMustReplyText 大小写不敏感匹配昵称', async () => {
  const entry = { items: [{ sender: 'A', text: 'msg1', plain: 'msg1', isOwner: false, media: [], messageId: '1' }] };
  const pendingSummaries = new Map([['group:456', entry]]);
  const b = {
    cfg: { social: {} },
    selfNickname: 'DeepSeekBot',
    social: { pendingSummaries, recentMessages: new Map(), states: new Map(), pendingTimers: new Map(), silentContext: new Map() },
    currentRoleHint: () => '',
    buildContextBlock: () => '',
    sanitizeUntrustedText: (s) => s,
    mediaHintFor: () => '',
    log() {},
    deliverPrompt: async () => {
      // 模拟投递 await 期间有新消息到达
      entry.items.push({ sender: 'B', text: 'msg2', plain: 'msg2', isOwner: false, media: [], messageId: '2' });
      return { ok: true };
    },
  };
  const loop = createSocialLoopV1(b);
  await loop.flushSummaries('group:456');
  assert.equal(entry.items.length, 1, 'await 期间新入队的摘要消息不能被丢失');
  assert.equal(entry.items[0].messageId, '2');

  const sm = createSocialStateMachineV1(b);
  assert.equal(sm.isMustReplyText('找一下 deepseekbot 聊聊'), true);
});

await test('ops: stop-bridge 兼容含空格路径与 macOS ps + send-voice 布尔选项不吞位置参数 + state-acl 拒绝符号链接', async () => {
  const spacedRoot = '/Users/my user/qq bridge';
  assert.equal(isBridgeProcess({ name: 'node', commandLine: `node ${spacedRoot}/src/bridge.js` }, spacedRoot), true);
  assert.equal(isGuardProcess({ name: 'bash', commandLine: `bash ${spacedRoot}/start.sh` }, spacedRoot), true);
  const psOut = `  500     1 /Applications/My Node.app/bin/node /Applications/My Node.app/bin/node ${spacedRoot}/src/bridge.js`;
  const parsed = parsePsTable(psOut);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'node');
  assert.ok(parsed[0].commandLine.includes('bridge.js'));

  const cli = parseVoiceCliArgs(['send', '--dry-run', 'hello.mp3', 'group:123', '--volume', '2']);
  assert.equal(cli.values['dry-run'], true);
  assert.equal(cli.values.volume, '2');
  assert.deepEqual(cli.positionals, ['send', 'hello.mp3', 'group:123']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-acl-'));
  try {
    const realFile = path.join(tmp, 'real.txt');
    const linkFile = path.join(tmp, 'link.txt');
    fs.writeFileSync(realFile, 'hi');
    fs.symlinkSync(realFile, linkFile);
    assert.equal(hardenFile(linkFile).ok, false, '应拒绝修改符号链接权限');
    assert.equal(isHardened(linkFile), false);
    assert.equal(hardenDir(linkFile).ok, false);
    assert.equal(manualDirCommand(`/tmp/a'b/state`), `chmod -R go-rwx '/tmp/a'\\''b/state'`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n✅ test-p2-reliability-fixes: ${passed} 项全部通过`);
