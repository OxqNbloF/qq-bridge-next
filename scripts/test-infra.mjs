// 测试底层小工具、存储和权限策略。
// 全程用临时目录和假数据，不连 QQ、不连 DSH，也不改真实文件权限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedTimerDelay, createAsyncHelpers } from '../src/infra/async.js';
import { createCappedLogger, createBridgeLog, createActivityLog, localClock, LOG_LINE_MAX } from '../src/infra/log.js';
import { createInstanceLock } from '../src/infra/lock.js';
import { hardenStateDirAcl } from '../src/infra/state-acl.js';
import { loadConfig } from '../src/infra/config.js';
import { segmentsToText, extractMediaFromSegments, sanitizeMediaSummary } from '../src/inbound/normalize.js';
import { createInboundContext } from '../src/inbound/context.js';
import { createForwardMediaRegistry } from '../src/inbound/forward.js';
import { createRecallHandler } from '../src/inbound/recall.js';
import { createRoleState } from '../src/features/roles/state.js';
import { createRoleCards } from '../src/features/roles/card.js';
import { createPresetPrompts } from '../src/features/presets/prompt.js';
import { createRoleInjectStore } from '../src/store/role-inject.js';
import { createWakeConfigV2 } from '../src/features/social-v2/wake-config.js';
import { createSchedulerV2 } from '../src/features/social-v2/scheduler.js';
import { createSplitter } from '../src/features/send/split.js';
import { createSendTimeline } from '../src/features/send/timeline.js';
import { createSendQueue } from '../src/features/send/queue.js';
import { createSendGuard } from '../src/policy/send-guard.js';
import { createVoiceBudget } from '../src/features/voice/budget.js';
import { createSlangWindow } from '../src/features/slang/window.js';
import { createUsageRecorder } from '../src/features/usage/record.js';
import { createInitialPromptStore } from '../src/store/initial-prompts.js';
import { createSnowlumaWs } from '../src/gateway/snowluma-ws.js';
import { createConversationStore } from '../src/store/conversations.js';
import { createMemoryPool } from '../src/store/pool.js';
import { createSlangPoolStore, slangEntryToPoolItem, poolItemToSlangEntry } from '../src/features/slang/pool.js';
import { normalizeSlangEntry } from '../src/slang-learner.js';
import { createFeedbackStore } from '../src/store/feedback.js';
import { createSessionStore } from '../src/store/sessions.js';
import { createAgentTokenRegistry, createTokenAudit } from '../src/policy/audit.js';
import { BOUND_SESSION_ID_RE, encodeSelfKey } from '../src/policy/self-key.js';
import { createPokeHandler } from '../src/inbound/poke.js';
import { createInboundMedia } from '../src/inbound/media.js';
import { createConversationPolicy } from '../src/conversations/policy.js';
import { createOutbox } from '../src/conversations/outbox.js';
import { createWakeLeases } from '../src/conversations/turns.js';
import { createDshDeliver } from '../src/dsh/deliver.js';
import { createDshWatch } from '../src/dsh/watch.js';
import { createDshModel } from '../src/dsh/model.js';
import { readJsonSafe } from '../src/store/fs-atomic.js';
import { DEFAULT_SOCIAL_V2_TOOLS, resolveSocialV2Tools } from '../src/policy/tool-defaults.js';
import { startArchiveRetention, compressCursorFrom } from '../src/store/archive-retention.js';
import { createMessageArchive } from '../src/store/archive.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
// 跑一个测试用例，出错就记失败
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}
// 建一个临时目录来用
const tmp = (p = 'qqb-infra-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── 异步小工具 ──
await test('async: boundedTimerDelay clamps non-finite and overflowing values', () => {
  assert.equal(boundedTimerDelay(Infinity, 5), 5, '非有限值走 fallback');
  assert.equal(boundedTimerDelay('x', 5), 5);
  assert.equal(boundedTimerDelay(-3), 0);
  assert.equal(boundedTimerDelay(1e12), 86400000);
  assert.equal(boundedTimerDelay(10, 0, 100), 100);
});

await test('async: sleep/withTimeout use the injected timers and clear on settle', async () => {
  const set = []; const cleared = [];
  const fake = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; set.push(t); return t; },
    clearTimeout: (t) => cleared.push(t),
  };
  const { sleep, withTimeout } = createAsyncHelpers(fake);
  const slept = sleep(1e12);
  const first = set.at(-1);
  assert.equal(first.ms, 86400000, 'sleep 经 boundedTimerDelay 收口');
  void sleep(Infinity);
  assert.equal(set.at(-1).ms, 0, '非有限值按 fallback 0 处理（与搬迁前一致）');
  first.fn(); await slept;
  assert.equal(await withTimeout(Promise.resolve(7), 50, 'x'), 7);
  assert.equal(cleared.length, 1, '成功后清掉超时定时器');
  const pending = withTimeout(new Promise(() => {}), 50, '停任务');
  set.at(-1).fn();
  await assert.rejects(pending, /操作超时\(50ms\)：停任务/);
});

// ── 日志 ──
await test('log: capped logger rotates to .1 by line count and creates its directory', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'nested', 'x.log');
    const append = createCappedLogger(file, 3);
    for (let i = 1; i <= 4; i++) append(`l${i}\n`);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'l1\nl2\nl3\nl4\n');
    assert.equal(fs.existsSync(file), false, '轮转是 rename，新文件下次写入时才出现');
    append('l5\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'l5\n');
    // 重启后从磁盘行数续数
    const again = createCappedLogger(file, 2);
    again('l6\n'); again('l7\n');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'l5\nl6\nl7\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('log: bridge log redacts, flattens newlines, truncates and survives EPIPE', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'bridge.log');
    const printed = [];
    const log = createBridgeLog({ file, redact: (s) => s.replaceAll('SECRET', '***'), console: { log: (l) => printed.push(l) } });
    log('a\nb', { token: 'SECRET' });
    log('x'.repeat(LOG_LINE_MAX + 50));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.match(lines[0], /^\d\d:\d\d:\d\d \[bridge\] a b \{"token":"\*\*\*"\}$/);
    assert.ok(lines[1].endsWith('…[截断]'));
    assert.deepEqual(printed, lines);
    const epipe = createBridgeLog({ file, redact: (s) => s, console: { log() { throw new Error('EPIPE'); } } });
    epipe('still written');
    assert.ok(fs.readFileSync(file, 'utf8').includes('still written'));
    const cyclic = {}; cyclic.self = cyclic;
    log(cyclic);
    assert.ok(fs.readFileSync(file, 'utf8').includes('(日志参数无法序列化)'));
    const activity = createActivityLog({ file: path.join(dir, 'a.log'), redact: (s) => s.toUpperCase() });
    activity('hi\nthere');
    assert.match(fs.readFileSync(path.join(dir, 'a.log'), 'utf8'), /^\[\d\d:\d\d:\d\d\] HI THERE\n$/);
    assert.equal(localClock(new Date(2026, 0, 1, 3, 4, 5).getTime()), '03:04:05');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 锁文件 ──
function lockFixture(dir, { kill = () => true, portOut = '', platform = 'linux' } = {}) {
  const exits = []; const errors = [];
  const lock = createInstanceLock({
    lockFile: path.join(dir, 'state', 'bridge.lock'),
    configFile: path.join(dir, 'config.json'),
    readJsonSafe: () => ({ consolePort: 3100 }),
    proc: { pid: 4242, platform, kill, exit: (code) => { exits.push(code); throw new Error(`exit ${code}`); } },
    execFileSync: () => portOut,
    error: (m) => errors.push(m),
  });
  return { lock, exits, errors, file: path.join(dir, 'state', 'bridge.lock') };
}

await test('lock: fresh acquire writes the PID; release only removes our own lock', () => {
  const dir = tmp();
  try {
    const f = lockFixture(dir);
    f.lock.acquireLock();
    assert.equal(fs.readFileSync(f.file, 'utf8'), '4242');
    fs.writeFileSync(f.file, '999');
    f.lock.releaseLock();
    assert.equal(fs.existsSync(f.file), true, '别人的锁不删');
    fs.writeFileSync(f.file, '4242');
    f.lock.releaseLock();
    assert.equal(fs.existsSync(f.file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('lock: dead PID / empty / recycled PID without console port are stale; live bridge exits 2', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'state'));
    // 假装进程已经不存在
    const esrch = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };
    for (const [content, opts] of [['777', { kill: esrch }], ['', {}], ['777', { portOut: '' }]]) {
      const f = lockFixture(dir, opts);
      fs.writeFileSync(f.file, content);
      f.lock.acquireLock();
      assert.equal(fs.readFileSync(f.file, 'utf8'), '4242', `content=${JSON.stringify(content)}`);
    }
    const live = lockFixture(dir, { portOut: 'tcp LISTEN 0 0 127.0.0.1:3100 *' });
    fs.writeFileSync(live.file, '777');
    assert.throws(() => live.lock.acquireLock(), /exit 2/);
    assert.equal(fs.readFileSync(live.file, 'utf8'), '777', '在跑的实例的锁不能被偷');
    // 假装没有权限
    const eperm = () => { const e = new Error('x'); e.code = 'EPERM'; throw e; };
    const guarded = lockFixture(dir, { kill: eperm, portOut: '' });
    guarded.lock.acquireLock();
    assert.ok(guarded.errors.some((m) => m.includes('EPERM')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 状态目录权限 ──
await test('state-acl: reports success/failure and prints the manual command on failure', () => {
  const logs = [];
  const base = { dir: '/q/state', manualDirCommand: (d) => `chmod -R go-rwx "${d}"`, log: (m) => logs.push(m) };
  assert.equal(hardenStateDirAcl({ ...base, hardenDir: () => ({ ok: true }) }), true);
  assert.equal(logs.length, 0);
  assert.equal(hardenStateDirAcl({ ...base, hardenDir: () => ({ ok: false, detail: 'denied' }) }), false);
  assert.match(logs[0], /chmod 700.*denied/);
  assert.ok(logs.at(-1).includes('chmod -R go-rwx "/q/state"'));
});

// ── 读配置 ──
await test('config: strict read, defaults, deep-merged tools, effort fallback, archive clamps', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'config.json');
    // 用这份配置内容加载一次，看会不会报错
    const load = (obj, extra = {}) => {
      fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
      const logs = [];
      const cfg = loadConfig({ configFile: file, readJsonSafe, discoverDshLaunchToken: () => 'launch-token', log: (m) => logs.push(m), ...extra });
      return { cfg, logs };
    };
    assert.throws(() => load('[1]'), /配置格式错误/);
    assert.throws(() => load('{bad json'), '读坏必须抛出，不能静默回落默认配置');
    const { cfg } = load({ allow: { groups: ['0456', 'x'] }, socialV2: { tools: { memory: false } } });
    assert.equal(cfg.dsh.baseUrl, 'http://127.0.0.1:3080');
    assert.equal(cfg.dsh.authToken, 'launch-token'); assert.equal(cfg.dsh.authTokenExplicit, false);
    assert.equal(cfg.socialV2.tools.memory, false); assert.equal(cfg.socialV2.tools.sendVoice, false);
    assert.equal(cfg.socialV2.voice.enabled, false);
    assert.equal(cfg.role.maxInjectChars, 8000); assert.equal(cfg.role.injectEveryNWakes, 4);
    assert.deepEqual(cfg.archive, { enabled: false, retentionDays: 90, maxShardMb: 64 });
    const bad = load({ dsh: { reasoningEffort: '\u0007', authToken: 'mine' }, archive: { enabled: true, maxShardMb: 99999, retentionDays: -1 }, role: { maxInjectChars: 50 } }, { roleInjectMaxCharsDefault: 7000 });
    assert.equal(bad.cfg.dsh.reasoningEffort, 'max');
    assert.match(bad.logs[0], /reasoningEffort「.*」非法，已回退 max/);
    assert.equal(load({ dsh: { reasoningEffort: 'high-x' } }).cfg.dsh.reasoningEffort, 'high-x', '适配器档位 ID 原样透传');
    assert.equal(bad.cfg.dsh.authTokenExplicit, true);
    assert.deepEqual(bad.cfg.archive, { enabled: true, retentionDays: 90, maxShardMb: 1024 });
    assert.equal(bad.cfg.role.maxInjectChars, 50, '范围校正由调用方做（roles 功能），loadConfig 原样返回');
    assert.equal(load({}, { roleInjectMaxCharsDefault: 7000 }).cfg.role.maxInjectChars, 7000);
    assert.equal(cfg.sessionWorkspace, 'per-conversation', '默认每聊天独立工作区');
    assert.equal(load({ sessionWorkspace: 'shared' }).cfg.sessionWorkspace, 'shared');
    assert.throws(() => load({ sessionWorkspace: 'per-chat' }), /sessionWorkspace 非法/, '非法值启动即报错，不静默共用');
    assert.throws(() => load({ turnStallMs: 'abc' }), /turnStallMs 非法/, '非数字不静默当 0 = 关');
    assert.throws(() => load({ socialV2: { flushIntervalMs: -1 } }), /flushIntervalMs 非法/);
    assert.equal(load({ turnStallMs: 0 }).cfg.turnStallMs, 0, '0 = 关仍合法');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 进来消息的处理 ──
await test('inbound/normalize: segments → text with injected resolvers; media metadata keeps emoji fields', async () => {
  const text = await segmentsToText([
    { type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' hi ' } }, { type: 'reply', data: { id: '9' } },
    { type: 'markdown', data: { content: '**x**' } }, { type: 'forward', data: { id: 'abc' } }, { type: 'weird' },
  ], { resolveAtName: async () => '阿豪', resolveReply: async () => ({ sender: '甲', text: '原文' }) });
  assert.equal(text, '@阿豪 hi [引用 甲：原文]**x**[转发消息 id=abc][weird]');
  assert.equal(await segmentsToText([{ type: 'reply', data: { id: '9' } }, { type: 'text', data: { text: 'x' } }], { includeReply: false }), 'x');
  assert.equal(await segmentsToText('  plain  '), 'plain');
  const media = extractMediaFromSegments([{ type: 'image', data: { file: 'a.gif', sub_type: 1, emoji_id: 'e1', summary: '狗\n头' } }, { type: 'face', data: { id: 14 } }]);
  assert.deepEqual(media[0], { kind: 'image', file: 'a.gif', url: '', subType: '1', summary: '狗 头', emojiId: 'e1', emojiPackageId: '', emojiKey: '' });
  assert.equal(media[1].kind, 'face');
  assert.equal(sanitizeMediaSummary('a\u2028b'), 'a b');
});

await test('inbound/context: reply lookups enforce conversation ownership and are cached; bot is resolved lazily', async () => {
  let bot = null; let calls = 0;
  const ctx = createInboundContext({ getBot: () => bot, log: () => {} });
  bot = { getMessage: async (id) => { calls++; return { group_id: id === 1 ? 456 : 789, sender: { card: '甲', user_id: 5 }, message: [{ type: 'text', data: { text: '原文' } }] }; } };
  assert.deepEqual(await ctx.resolveReplyInfo('group', '456', '1'), { sender: '甲', text: '原文', userId: '5' });
  await ctx.resolveReplyInfo('group', '456', '1');
  assert.equal(calls, 1, '命中缓存');
  assert.equal(await ctx.resolveReplyInfo('group', '456', '2'), null, '别的群的消息不能跨会话读');
  assert.equal(await ctx.isQuoteTargetSelf([{ type: 'reply', data: { id: '1' } }], 'group', '456', 5), true);
  assert.ok(ctx.replyInfoCache.size >= 2);
  bot.getGroupMemberList = async () => [{ user_id: 111 }];
  assert.equal(await ctx.assertGroupMember(456, 111), null);
  assert.match(await ctx.assertGroupMember(456, 222), /不是群 456 的成员/);
});

await test('inbound/forward: only media seen in this conversation is registered; oversized refs are rejected', () => {
  const reg = createForwardMediaRegistry();
  reg.rememberForwardMedia('group:0456', [{ media: [{ kind: 'image', url: 'https://x.invalid/a' }, { kind: 'image' }] }]);
  const refs = reg.forwardMediaRefs.get('group:456');
  assert.equal(refs.size, 1, '规范化 key；空媒体项不登记');
  assert.ok(refs.has(reg.forwardMediaKey({ kind: 'image', url: 'https://x.invalid/a' })));
  reg.rememberForwardMedia('bad', [{ media: [{ kind: 'image', url: 'u' }] }]);
  assert.equal(reg.forwardMediaRefs.size, 1);
  assert.equal(reg.forwardMediaKey({ kind: 'image', url: 'x'.repeat(9000) }), '');
});

await test('inbound/media: limits are clamped from cfg once; unsafe file refs never reach get_image', async () => {
  let getImageCalls = 0;
  const m = createInboundMedia({
    cfg: { socialV2: { media: { maxBytes: 1, maxCount: 99, maxPixels: 1 } }, snowluma: {} },
    log: () => {}, getBot: () => ({ getImage: async () => { getImageCalls++; return {}; } }), getMode: () => 'reserved2',
    getSocialV2: () => ({ conversations: new Map() }), getSocialV2State: () => null, getMessageMediaStore: () => new Map(),
    safeFetchBuffer: async () => { throw new Error('offline'); }, looksLikeImageBuffer: () => true,
    normalizeImageForModel: async (buffer, mimeType) => ({ ok: true, buffer, mimeType }), env: {},
  });
  assert.equal(m.MAX_MEDIA_BYTES, 256 * 1024); assert.equal(m.MAX_MEDIA_COUNT, 8); assert.equal(m.MAX_MEDIA_PIXELS, 1_000_000);
  assert.equal(m.isProbablySafeImageFileRef('../etc/passwd'), false);
  assert.equal(m.isProbablySafeImageFileRef('abc.png'), true);
  assert.equal(await m.fetchOneBotImage({ kind: 'image', file: 'C:\\x.png' }), null);
  assert.equal(getImageCalls, 0);
  await m.fetchOneBotImage({ kind: 'image', file: 'abc.png' });
  assert.equal(getImageCalls, 1);
  assert.equal(m.mimeFromBuffer(Buffer.from('GIF89a000000', 'ascii')), 'image/gif');
  assert.deepEqual(m.emojiCdnCandidates('zz'), []);
  assert.match(m.mediaHintFor('group:1', '7', [{}]), /qq_get_message_images/);
});

await test('inbound/recall: placeholder keeps seq, derived caches for that conversation are cleared', () => {
  const st = { recentMessages: [{ seq: 7, messageId: '99', text: '秘密', media: [{}], forwardIds: ['f1'] }], unread: [{ seq: 7, messageId: '99', text: '秘密' }] };
  const replyInfoCache = new Map([['group:456:99', {}], ['group:789:99', {}]]);
  const media = new Map([['99', []], ['7', []], ['8', []]]);
  const forwardSeen = new Set(['f1', 'f2']);
  let saved = 0; const archived = [];
  const r = createRecallHandler({
    convKey: (k, i) => `${k}:${i}`, log: () => {}, saveSocialV2State: () => { saved++; },
    archiveSafely: (op, fn) => fn({ lastSeq: () => 3, markRecalled: (...a) => archived.push(a) }),
    socialV2: { conversations: new Map([['group:456', st]]) },
    replyInfoCache, messageMediaStore: new Map([['group:456', media]]), seenForwardIds: new Map([['group:456', forwardSeen]]),
  });
  assert.equal(r.handleRecallNotice({ notice_type: 'group_recall', group_id: 456, message_id: 99, operator_id: 1 }), true);
  assert.equal(st.recentMessages[0].text, '[该消息已被撤回]'); assert.equal(st.recentMessages[0].seq, 7);
  assert.equal(st.unread[0].recalled, true);
  assert.deepEqual([...replyInfoCache.keys()], ['group:789:99'], '只清本会话的引用缓存');
  assert.deepEqual([...media.keys()], ['8']);
  assert.deepEqual([...forwardSeen], ['f2']);
  assert.equal(saved, 1); assert.deepEqual(archived[0].slice(0, 2), ['group:456', '99']);
  assert.equal(r.handleRecallNotice({ notice_type: 'notify' }), false);
});

await test('inbound/poke: own pokes and non-whitelisted conversations are ignored; other modes only log', async () => {
  const activity = []; let wakes = 0;
  const b = {
    cfg: { ignore: { sendQQ: [] } }, currentMode: 'chat', convKey: (k, i) => `${k}:${i}`,
    modeAllowed: (key) => key === 'group:456', appendActivity: (l) => activity.push(l), scheduleWakeV2: () => { wakes++; },
  };
  b.modeForKey = createConversationPolicy(b).modeForKey;
  const p = createPokeHandler(b);
  await p.handlePokeNotice({ sub_type: 'poke', self_id: 10, user_id: 10, group_id: 456, target_id: 5 });
  await p.handlePokeNotice({ sub_type: 'poke', self_id: 10, user_id: 3, group_id: 789, target_id: 5 });
  assert.equal(activity.length, 0, '自己发的 / 非白名单会话不处理');
  await p.handlePokeNotice({ sub_type: 'poke', self_id: 10, user_id: 3, group_id: 456, target_id: 5 });
  assert.equal(activity.length, 1); assert.match(activity[0], /非 reserved2，仅记录/);
  assert.equal(wakes, 0);
});

// ── 会话状态 ──
function policyFixture(over = {}) {
  const logs = [];
  const b = {
    cfg: { ownerQQ: 123, agentPreset: 'qq-chat', socialV2: { agentPreset: 'qq-chat-v2' }, allow: { private: ['123'], groups: ['456'] }, deny: { private: [], groups: [] } },
    currentMode: 'reserved2', closedAgentPreset: '', dshPresetIds: ['qq-chat', 'qq-chat-v2', 'standard'], dshDefaultPreset: 'standard',
    state: { sessions: {}, sessionPolicies: {} }, log: (m) => logs.push(m),
    ...over,
  };
  return { b, logs, p: createConversationPolicy(b) };
}

await test('conversations/policy: chat/simulation presets fail closed; closed-agent may fall back; owner-only', () => {
  const { b, p, logs } = policyFixture();
  assert.equal(p.resolvePresetName('qq-chat-v2', { strict: true }), 'qq-chat-v2');
  assert.equal(p.resolvePresetName('missing', { strict: true }), '', '群聊不得回退到带本地工具的默认 preset');
  assert.ok(logs.some((m) => m.includes('拒绝回退')));
  assert.equal(p.resolvePresetName('missing'), 'standard', 'closed-agent（仅 owner 私聊）可回退');
  assert.equal(p.modePreset('group:456', 'reserved2', b.cfg), 'qq-chat-v2');
  b.dshPresetIds = [];
  assert.equal(p.resolvePresetName('qq-chat', { strict: true }), '', '清单未知也 fail-closed');
  assert.equal(p.modeAllowed('private:123', 'private', 123, b.cfg, 'closed-agent'), true);
  assert.equal(p.modeAllowed('group:456', 'group', 456, b.cfg, 'closed-agent'), false);
  assert.equal(p.isSessionAllowedInCurrentMode('group:456'), true);
  assert.equal(p.isSessionAllowedInCurrentMode('group:789'), false);
  assert.equal(p.isSessionAllowedInCurrentMode('bogus'), false);
});

await test('conversations/policy: reads mode state through the accessor; empty preset list never retires sessions', () => {
  let retired = 0;
  const { b, p } = policyFixture();
  b.state.sessions = { 'group:456': 's1' };
  b.state.sessionPolicies = { 'group:456': 'stale-policy' };
  b.currentMode = 'chat';
  assert.equal(p.sessionPolicy('group:456'), JSON.stringify(['chat', 'qq-chat', null]), '策略指纹跟随访问器里的当前模式');
  b.dshPresetIds = [];
  b.saveState = () => { retired++; };
  p.reconcileSessionPolicies();
  assert.equal(retired, 0, '清单为空时绝不做退役判定');
  assert.equal(b.state.sessions['group:456'], 's1');
});

await test('conversations/outbox: dedupes, caps at QUEUE_MAX dropping the oldest, and schedules a flush', () => {
  const timers = []; const logs = [];
  const o = createOutbox({ log: (m) => logs.push(m), setTimeout: (fn, ms) => { timers.push(ms); return {}; } });
  o.enqueueForRetry('group:1', 'a');
  o.enqueueForRetry('group:1', 'a');
  assert.equal(o.queued.get('group:1').length, 1, '同文本不重复入队');
  for (let i = 0; i < o.QUEUE_MAX + 2; i++) o.enqueueForRetry('group:1', `m${i}`);
  assert.equal(o.queued.get('group:1').length, o.QUEUE_MAX);
  assert.equal(o.queued.get('group:1')[0].promptText, 'm2', '满了丢最旧');
  assert.ok(logs.some((m) => m.includes('队列满')));
  assert.ok(timers.every((ms) => ms === 3000));
});

await test('conversations/turns: wake lease expires the busy flag and can be disarmed', () => {
  const pendingWakeKeys = new Set(['group:1']); const fired = [];
  const l = createWakeLeases({ pendingWakeKeys, setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; fired.push(t); return t; }, clearTimeout: () => {} });
  l.armPendingWakeLease('group:1');
  assert.equal(fired[0].ms, 30 * 60 * 1000);
  fired[0].fn();
  assert.equal(pendingWakeKeys.has('group:1'), false);
  l.armPendingWakeLease('group:2'); l.disarmPendingWakeLease('group:2');
  assert.equal(l.pendingWakeLeaseTimers.size, 0);
});

// ── 和 DSH 打交道 ──
await test('dsh/deliver: queued prompts for a disallowed conversation all settle and the queue is removed; drain rejects pending items', async () => {
  const d = createDshDeliver({ isSessionAllowedInCurrentMode: () => false });
  const { promptQueues } = d;
  const results = await Promise.allSettled([d.deliverPrompt('group:1', 'a'), d.deliverPrompt('group:1', 'b')]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.match(results[0].reason.message, /当前模式不允许会话 group:1/);
  assert.equal(promptQueues.size, 0, '跑空后删除队列');
  const item = { reject: (e) => { item.err = e; } };
  promptQueues.set('group:2', { queue: [item], running: true });
  d.drainPromptQueue('group:2', '会话已重置');
  assert.equal(item.err.message, '会话已重置');
  assert.equal(promptQueues.has('group:2'), false);
});

await test('dsh/watch: endpoint rediscovery goes through the injected discoverer, honours opt-out and cooldown', async () => {
  const calls = []; const rebinds = [];
  const b = {
    cfg: { dsh: {} }, log: () => {},
    api: { resolveBase: () => 'http://127.0.0.1:3080', rebind: (u) => rebinds.push(u) },
    discoverDshBaseUrl: async (opts) => { calls.push(opts.current); return 'http://127.0.0.1:61981'; },
  };
  const w = createDshWatch(b);
  assert.equal(await w.rediscoverDshBase(), true);
  assert.deepEqual(rebinds, ['http://127.0.0.1:61981']);
  assert.equal(await w.rediscoverDshBase(), false, '30 秒冷却');
  assert.equal(calls.length, 1);
  const off = createDshWatch({ ...b, cfg: { dsh: { autoDiscoverPort: false } } });
  assert.equal(await off.rediscoverDshBase(), false);
  assert.equal(calls.length, 1, '关闭后不探测');
});

await test('dsh/model: nominal model follows live cfg; selectModel is applied once per session epoch', async () => {
  const requests = [];
  const b = {
    cfg: { dsh: { provider: 'p', model: 'm1', reasoningEffort: 'max' } }, log: () => {}, sleep: async () => {},
    modelSelectionEpoch: 1, modelAppliedSessions: new Map(),
    api: { sessions: { selectModel: async (payload) => { requests.push(payload); return { result: { ok: true, value: { selected: payload } } }; } } },
  };
  const m = createDshModel(b);
  assert.equal(m.nominalModel(), 'm1');
  b.cfg.dsh.model = 'm2';
  assert.equal(m.nominalModel(), 'm2', '控制台热改配置后立即生效');
  assert.equal(await m.ensureChatModel('s1'), 'applied');
  assert.equal(await m.ensureChatModel('s1'), 'applied');
  assert.equal(requests.length, 1, '同一 epoch 只 selectModel 一次');
  b.modelSelectionEpoch = 2;
  await m.ensureChatModel('s1');
  assert.equal(requests.length, 2, 'epoch 变化后重新应用');
});

// ── 工具默认开关 ──
await test('tool-defaults: every MCP registration flag has a bridge default (single source)', () => {
  const source = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  const block = source.slice(source.indexOf('const TOOL_CONFIG_FLAGS = {'), source.indexOf('};', source.indexOf('const TOOL_CONFIG_FLAGS = {')));
  const flags = [...block.matchAll(/^\s+qq_\w+: '(\w+)',/gm)].map((m) => m[1]);
  assert.ok(flags.length >= 30, `解析到 ${flags.length} 个开关`);
// 没登记的开关默认算开着，这里列出例外，漏登记就会报错
  const implicit = [...new Set(flags.filter((flag) => DEFAULT_SOCIAL_V2_TOOLS[flag] === undefined))];
  assert.deepEqual(implicit, ['getGroupMembers']);
  for (const flag of flags) assert.notEqual(resolveSocialV2Tools(undefined)[flag], undefined === DEFAULT_SOCIAL_V2_TOOLS[flag] ? false : undefined);
  assert.equal(DEFAULT_SOCIAL_V2_TOOLS.sendVoice, false);
  assert.equal(DEFAULT_SOCIAL_V2_TOOLS.setStickerRemark, false);
  assert.equal(resolveSocialV2Tools({ sendVoice: true }).sendVoice, true);
  assert.equal(resolveSocialV2Tools(null).memory, true);
  assert.equal(resolveSocialV2Tools(['x']).getPrompt, true);
  assert.throws(() => { DEFAULT_SOCIAL_V2_TOOLS.sendVoice = true; }, TypeError, '默认表冻结');
});

// ── 归档保留期 ──
await test('retention: daily timer, no-op without a compress cursor, disabled for permanent retention', () => {
  const timers = []; const intervals = [];
  const fake = {
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() { t.unref = true; } }; timers.push(t); return t; },
    setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; },
    clearTimeout() {}, clearInterval() {},
  };
  const calls = [];
  const archive = { prune: (opts) => { calls.push(opts); return []; } };
  const handle = startArchiveRetention({ archive, retentionDays: 90, cursorFor: compressCursorFrom({}), timers: fake });
  assert.equal(handle.active, true);
  assert.equal(timers.length, 1); assert.equal(timers[0].unref, true);
  timers[0].fn();
  assert.equal(calls.length, 1); assert.equal(calls[0].olderThanDays, 90);
  assert.equal(calls[0].cursorFor('group:1'), 0, '记忆系统未登记游标 ⇒ 0 ⇒ 不删除');
  assert.equal(intervals[0].ms, 86400000);
  assert.equal(startArchiveRetention({ archive, retentionDays: 0, cursorFor: () => 0, timers: fake }).active, false);
  const cursor = compressCursorFrom({ compressCursor: { get: (c) => (c === 'group:1' ? 12 : NaN) } });
  assert.equal(cursor('group:1'), 12); assert.equal(cursor('group:2'), 0);
  const logs = [];
  const broken = startArchiveRetention({ archive: { prune() { throw new Error('disk'); } }, retentionDays: 1, cursorFor: () => 0, timers: fake, log: (m) => logs.push(m) });
  assert.deepEqual(broken.runOnce(), []);
  assert.match(logs[0], /保留期清理失败：disk/);
});

await test('retention: with a registered cursor, old fully-consumed shards are pruned for real', () => {
  const dir = tmp();
  try {
    const DAY = 86400000; const t0 = Date.UTC(2026, 0, 1, 12);
    let now = t0;
    const a = createMessageArchive({ dir, now: () => now });
    a.append({ conv_id: 'group:1', msg_id: '1', text: 'old' });
    now = t0 + 200 * DAY;
    a.append({ conv_id: 'group:1', msg_id: '2', text: 'new' });
    const fake = { setTimeout: () => ({}), setInterval: () => ({}), clearTimeout() {}, clearInterval() {} };
    const none = startArchiveRetention({ archive: a, retentionDays: 90, cursorFor: compressCursorFrom({}), timers: fake });
    assert.equal(none.runOnce().length, 0);
    const some = startArchiveRetention({ archive: a, retentionDays: 90, cursorFor: compressCursorFrom({ compressCursor: { get: () => 1 } }), timers: fake });
    assert.equal(some.runOnce().length, 1);
    assert.deepEqual(a.range('group:1').map((r) => r.msg_id), ['2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 隐私删除小工具 ──
await test('redact CLI: refuses while the bridge lock exists, redacts and releases its own lock otherwise', () => {
  const dir = tmp();
  try {
    const a = createMessageArchive({ dir: path.join(dir, 'state', 'archive') });
    a.append({ conv_id: 'group:1', msg_id: '42', text: '要删掉的隐私', nick: '某人' });
    a.append({ conv_id: 'group:1', msg_id: '43', text: '保留' });
    // 跑一次隐私删除工具
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/archive-redact.mjs'), '--root', dir, ...args], { encoding: 'utf8' });
    const lock = path.join(dir, 'state', 'bridge.lock');
    fs.writeFileSync(lock, '1');
    const blocked = cli('group:1', '42');
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.ok(fs.readFileSync(path.join(dir, 'state', 'archive', 'group_1', fs.readdirSync(path.join(dir, 'state', 'archive', 'group_1'))[0]), 'utf8').includes('要删掉的隐私'));
    fs.unlinkSync(lock);
    const done = cli('group:1', '42');
    assert.equal(done.status, 0, done.stderr);
    assert.equal(fs.existsSync(lock), false, 'CLI 释放自己拿的锁');
    const after = createMessageArchive({ dir: path.join(dir, 'state', 'archive') }).range('group:1');
    assert.equal(after[0].redacted, true); assert.equal(after[0].text, ''); assert.equal(after[0].seq, 1);
    assert.equal(after[1].text, '保留');
    assert.equal(cli('group:1', 'nope').status, 3);
    assert.equal(cli('bad-key', '1').status, 64);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 发出去的图片语音也要记账 ──
function call(server, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

await test('bridge: sticker, voice and poke sends are archived as bot messages with media metadata', async () => {
  const audioDir = tmp('qqb-infra-audio-');
  fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(64));
  let nextId = 500;
  const h = await bridgeHarness({
    config: { archive: { enabled: true }, sendDelayMs: 0 },
    globals: {
      safeFetchBuffer: async () => ({ buffer: Buffer.from('89504e470d0a1a0a00000000', 'hex') }),
      inspectAudio: async () => ({ ok: true, size: 64, duration: 1, codec: 'mp3', warnings: [] }),
      fetch: async (url) => {
        const action = String(url).split('/').pop();
        if (action === 'fetch_custom_face_detail') return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker', desc: '狗头' }] }) };
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: nextId++ } }) };
      },
    },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    h.setMode('reserved2');
    await h.sendStickerV2('group:456', 'fixture-sticker', { replyToMessageId: '-77' });
    await h.sendVoiceV2('group:456', path.join(audioDir, 'hello.mp3'), { guard: false, audit: true });
    await h.ensureSession('group:456');
    const token = h.getSocialV2State('group:456').agentToken;
    h.bot.getGroupMemberList = async () => [{ user_id: 111 }];
    h.bot.raw = async () => ({});
    const poke = await call(server, '/api/socialV2/send-poke', token, { key: 'group:456', targetUserId: '111' });
    assert.equal(poke.status, 200, JSON.stringify(poke.json));
    const bot = h.messageArchive.range('group:456').filter((r) => r.from === 'bot');
    assert.deepEqual(bot.map((r) => r.text), ['[表情:fixture-sticker]', '[语音:hello.mp3]', '[拍一拍] 我拍了拍 111']);
    assert.equal(bot[0].msg_id, 'bot-500'); assert.equal(bot[0].reply_to, '-77');
    assert.equal(bot[0].media[0].subType, 'sticker'); assert.equal(bot[0].media[0].emojiId, 'fixture-sticker');
    assert.deepEqual(bot[1].media, [{ kind: 'record', file: 'hello.mp3', sizeBytes: 64 }]);
    assert.equal(bot[1].msg_id, 'bot-501');
    assert.ok(bot[2].msg_id.startsWith('local-'), '拍一拍没有 message_id，用本地 id');
    assert.deepEqual(bot[2].media, [{ kind: 'poke', summary: '111' }]);
    assert.ok(!JSON.stringify(bot).includes('public.invalid'), '表情 url 不落盘');
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
    fs.rmSync(audioDir, { recursive: true, force: true });
  }
});

// ── 角色和预设 ──
await test('roles: names are sanitized and validated; state file round-trips; role list skips README', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'roles'));
    for (const f of ['小鲸鱼.md', 'README.md', 'b.md', 'note.txt']) fs.writeFileSync(path.join(dir, 'roles', f), '# x\n');
    const st = createRoleState({ ROOT: dir, ROLE_STATE_FILE: path.join(dir, 'current-role.json') });
    assert.deepEqual(st.listRoles(), ['b', '小鲸鱼'].sort((x, y) => x.localeCompare(y, 'zh-CN')));
    assert.deepEqual(st.readRoleState(), { role: null, mode: 'active' }, '文件不存在时的默认值');
    st.writeRoleState('小鲸鱼', 'silent');
    assert.deepEqual(st.readRoleState(), { role: '小鲸鱼', mode: 'silent' });
    assert.equal(st.sanitizeRoleName('../..\\evil name!'), 'evilname', '路径分隔符与空白被剥掉');
    const cards = createRoleCards({ ROOT: dir, ROLE_INJECT_MAX_CHARS_DEFAULT: 8000, roleInjectMaxChars: 8000, listRoles: st.listRoles, sanitizeRoleName: st.sanitizeRoleName });
    assert.equal(cards.validateRoleName(' 小鲸鱼 '), '小鲸鱼');
    for (const bad of ['', '///', 'README', 'con', 'LPT1', 'x'.repeat(41)]) assert.throws(() => cards.validateRoleName(bad), `应拒绝 ${JSON.stringify(bad)}`);
    assert.equal(cards.roleFilePath('小鲸鱼'), path.join(dir, 'roles', '小鲸鱼.md'));
    assert.throws(() => cards.validateRoleContent('   '));
    assert.throws(() => cards.validateRoleContent('字'.repeat(30000)), /过长/);
    assert.equal(cards.applyRoleInjectLimit(50), 1000); assert.equal(cards.applyRoleInjectLimit(99999), 20000); assert.equal(cards.applyRoleInjectLimit('x'), 8000);
    cards.writeRoleContent('新卡', '内容');
    assert.equal(cards.readRoleContent('新卡'), '内容\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('presets: only the two built-in preset names are accepted (path traversal → null)', () => {
  const p = createPresetPrompts({ ROOT: '/repo', STATE_DIR: '/repo/state', process: { env: {} }, renderPatch: () => '' });
  assert.equal(p.knownPresetName(''), 'qq-chat-v2', '缺省是二代');
  assert.equal(p.knownPresetName('qq-chat'), 'qq-chat');
  for (const bad of ['..\\..\\x', '../../etc', 'standard', 'qq-chat-v3']) assert.equal(p.knownPresetName(bad), null, bad);
  assert.equal(p.presetSourceYaml('qq-chat-v2'), path.join('/repo', 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'));
  assert.equal(p.PRESET_BACKUP_DIR, path.join('/repo/state', 'preset-backups'));
});

await test('store/role-inject: counts are stamped and atomic; a newer-schema file is never overwritten', () => {
  const dir = tmp();
  try {
    // 建一个记录角色写入的存储来测
    const mk = () => createRoleInjectStore({ STATE_DIR: dir, ROLES_DIR: path.join(dir, 'roles'), log: () => {},
      readRoleState: () => ({ role: '卡', mode: 'active' }), sanitizeRoleName: (n) => n });
    const a = mk();
    assert.equal(a.roleCardSignature(), '卡:missing', '卡文件不存在时的签名');
    a.roleInjectStore()['group:1'] = { count: 3 };
    a.saveRoleInjectStore();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'role-inject.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, 1); assert.deepEqual(onDisk['group:1'], { count: 3 });
    fs.writeFileSync(path.join(dir, 'role-inject.json'), JSON.stringify({ schemaVersion: 99, future: true }));
    const b2 = mk();
    b2.roleInjectStore()['group:2'] = { count: 1 };
    b2.saveRoleInjectStore();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'role-inject.json'), 'utf8')), { schemaVersion: 99, future: true }, '更新版本写过的文件不回写');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 二代聊天状态 ──
await test('social-v2/wake-config: speaker ids are cleaned, de-duplicated and capped; trigger keys are whitelisted', () => {
  const w = createWakeConfigV2({ cfg: { socialV2: { wake: {} } }, log() {} });
  assert.deepEqual(w.normalizeSpeakerIdsV2(['123', 'null', null, {}, '123', 'abc', -5]), ['123'], '脏数据与重复项被丢弃');
  assert.deepEqual(w.normalizeSpeakerIdsV2('1, 2，3 4'), ['1', '2', '3', '4'], '字符串按逗号/空白拆分');
  assert.deepEqual(w.normalizeSpeakerIdsV2(undefined), []);
  assert.equal(w.normalizeSpeakerIdsV2(Array.from({ length: 40 }, (_, i) => i + 1)).length, 20, '最多 20 个');
  assert.deepEqual(w.pickWakeTriggersV2({ atMention: true, evil: 1, probability: 0.3 }), { atMention: true, probability: 0.3 }, '白名单之外的键被丢弃');
  assert.equal(w.isSleepingConfigV2({ mode: 'diving' }), true);
  assert.equal(w.isSleepingConfigV2({ mode: 'active' }), false);
});

await test('social-v2/scheduler: wake reasons keep their priority order and directed/timer classification', () => {
  const s = createSchedulerV2({});
  // 取这个唤醒原因的优先级
  const pr = (r) => s.wakePriorityV2(r);
  assert.ok(pr('atMention') > pr('anyMessage') && pr('anyMessage') > pr('replyCheck') && pr('replyCheck') > pr('timeout'), '被 @ > 活跃期消息 > 回复检查 > 睡眠到期');
  assert.equal(s.isDirectedWakeReason('atMention'), true); assert.equal(s.isDirectedWakeReason('poke'), true);
  assert.equal(s.isDirectedWakeReason('anyMessage'), false);
  for (const r of ['timeout', 'bootstrap', 'admin', 'replyCheck']) assert.equal(s.isTimerWakeReason(r), true, r);
  assert.equal(s.isTimerWakeReason('atMention'), false);
});

// ── 一代仿真 ──
await test('bridge: gen-1 simulation buffers chatter, goes active when addressed, and feeds silent summaries', async () => {
// 默认有随机延迟和随机触发，模拟真人。
// 测试里把随机性设成 0，否则结果会时好时坏。
  const mk = () => bridgeHarness({ config: { sendDelayMs: 0, ackMessage: '', social: { activeReplyDelayMinMs: 0, activeReplyDelayMaxMs: 0, triggerProbability: 0 } } });
  // 造一条群消息
  const ev = (text, id, extra = []) => ({
    post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456, user_id: 999, message_id: id,
    time: Math.floor(Date.now() / 1000), sender: { nickname: '小明', card: '小明' }, message: [...extra, { type: 'text', data: { text } }],
  });
  // 取出所有发给模型的话
  const promptText = (h) => h.calls.prompts.map((p) => p.content.map((c) => c.text ?? '').join('')).join('\n----\n');
  // 等一下让异步跑完
  const settle = () => new Promise((r) => setTimeout(r, 200));

  // ① 闲聊只进摘要缓冲，不打扰模型；被 @ 之后进入活跃并带着聊天背景投递。
  const h = await mk();
  try {
    h.setMode('reserved'); h.setReady(true); h.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    await h.handleIncoming('group', '456', ev('今天天气不错', 1), h.cfg);
    assert.equal(h.socialState('group:456').phase, 'idle');
    assert.equal(h.calls.prompts.length, 0, '没人对它说话：不投递');
    assert.deepEqual(h.social.pendingSummaries.get('group:456').items.map((i) => i.text), ['今天天气不错']);
    await h.handleIncoming('group', '456', ev('你怎么看', 2, [{ type: 'at', data: { qq: '10002' } }]), h.cfg);
    await settle();
    assert.equal(h.socialState('group:456').phase, 'active', '被 @ 后进入活跃');
    assert.equal(h.calls.prompts.length, 1);
    assert.ok(promptText(h).includes('【群聊上下文】') && promptText(h).includes('今天天气不错') && promptText(h).includes('【当前消息】'), promptText(h).slice(0, 200));
  } finally { await h.close(); }

  // ② 摘要投喂：把缓冲的闲聊一次交给模型，占一个「静默回合」名额，缓冲清空；心跳在空闲态不出错。
  const h2 = await mk();
  try {
    h2.setMode('reserved'); h2.setReady(true); h2.setPresets(['qq-chat', 'qq-chat-v2', 'standard']);
    await h2.handleIncoming('group', '456', ev('今天天气不错', 1), h2.cfg);
    await h2.handleIncoming('group', '456', ev('是啊', 2), h2.cfg);
    await h2.flushSummaries('group:456');
    await settle();
    assert.equal(h2.calls.prompts.length, 1);
    assert.ok(promptText(h2).includes('【群聊摘要】') && promptText(h2).includes('是啊') && promptText(h2).includes('你不需要回复'), promptText(h2).slice(0, 200));
    assert.equal(h2.social.pendingSummaries.has('group:456'), false, '投喂后缓冲清空');
    assert.equal(h2.social.silentTurns.size, 1, '摘要回合记为静默（回复不转发到群里）');
    h2.socialLoopTick();
    assert.equal(h2.socialState('group:456').phase, 'idle');
  } finally { await h2.close(); }
});

// ── 发送和发送检查 ──
await test('send/split + timeline: spaces between CJK split messages; URLs survive hard cuts; gaps are clamped', () => {
  const sp = createSplitter({});
  assert.deepEqual(sp.splitByCjkSpaces('你好 在吗 hello world 好的'), ['你好', '在吗', 'hello world', '好的'], '英文单词之间的空格不分条');
  assert.equal(sp.singleLineForQQ('a\n\nb'), 'a b');
  const url = 'https://example.com/very/long/path?q=1&x=2';
  for (const n of [1, 470, 480, 499, 500, 520]) {
    const joined = sp.splitLongSegment('啊'.repeat(n) + url, 500).join('');
    assert.ok(joined.includes(url) && !joined.includes('\u0000') && !joined.includes('URL0'), `n=${n}: URL 必须完整、占位符不外泄`);
  }
  const t = createSendTimeline({ splitByCjkSpaces: sp.splitByCjkSpaces, splitLongSegment: sp.splitLongSegment, singleLineForQQ: sp.singleLineForQQ });
  assert.deepEqual(t.planSocialTimeline('第一句 第二句，还是第二句 第三句', { maxReplyChars: 500 }).main, ['第一句', '第二句，还是第二句', '第三句']);
  const cfg = { burstIntervalMinMs: 300, maxGapMs: 10000 };
  assert.deepEqual([t.clampGapV2(5, cfg), t.clampGapV2(99999, cfg), t.clampGapV2('x', cfg)], [300, 10000, 300]);
  assert.deepEqual(t.computeGapsV2(['a', 'b', 'c'], 'fixed', 1200, null, cfg), [1200, 1200]);
  assert.deepEqual(t.computeGapsV2(['a', 'b', 'c'], 'fixed', 0, [50, 20000], cfg), [300, 10000], '调用方给的间隔也要收敛到安全区间');
  assert.deepEqual(t.computeGapsV2(['a'], 'auto', 0, null, cfg), [], '单条消息没有间隔');
});

await test('send/queue + send-guard: per-conversation chain is forgotten when done; audit/silent exemptions are owner-private only', async () => {
  const q = createSendQueue({});
  const chain = q.rememberSendChain('group:1', Promise.resolve(1));
  assert.equal(q.sendChainFor('group:1'), chain, '在途时同会话的后续发送接在这条链后面');
  assert.notEqual(q.sendChainFor('group:2'), chain, '别的会话不共用');
  await chain; await null;
  assert.notEqual(q.sendChainFor('group:1'), chain, '链跑完即清理，不无界增长');
  assert.equal(q.lastSendSucceeded('group:1'), true);
  q.lastSendFailed.set('group:1', true);
  assert.equal(q.lastSendSucceeded('group:1'), false);

  const b = { currentMode: 'closed-agent', cfg: { ownerQQ: 123 }, readRoleState: () => ({ mode: 'silent' }) };
  b.modeForKey = createConversationPolicy(b).modeForKey;
  const g = createSendGuard(b);
  assert.equal(g.shouldAuditKey('private:123'), false, 'closed-agent 下只有 owner 私聊免审计');
  assert.equal(g.shouldAuditKey('group:456'), true);
  b.currentMode = 'reserved2';
  assert.equal(g.shouldAuditKey('private:123'), true, '其它模式一律审计');
  assert.equal(g.shouldBlockSilentReply('group:456'), true, '静默模式拦截群回复');
  assert.equal(g.shouldBlockSilentReply('private:123'), false, 'owner 私聊不受静默影响');
});

// ── 语音、黑话、用量 ──
await test('voice/budget: checking never consumes quota; only a committed send does; over-limit is a 429', () => {
  const v = createVoiceBudget({});
  const { voiceSendTimes } = v;
  const lim = { maxPerMinute: 2, maxPerHour: 3 };
  for (let i = 0; i < 5; i += 1) v.voiceBudgetCheck('group:1', lim);
  assert.equal(voiceSendTimes.has('group:1'), false, '只检查不占额度：失败的发送不能吃配额');
  v.voiceBudgetCommit('group:1'); v.voiceBudgetCommit('group:1');
  assert.throws(() => v.voiceBudgetCheck('group:1', lim), (e) => e instanceof v.VoiceRateLimitError && e.statusCode === 429 && /每分钟/.test(e.message));
  v.voiceBudgetCheck('group:2', lim); // 别的会话各算各的
  v.voiceBudgetCheck('group:1', { maxPerMinute: 0, maxPerHour: 0 }); // 0 = 不限
  const now = Date.now();
  voiceSendTimes.set('group:3', [now - 2 * 3600000, now - 120000, now - 110000, now - 100000]);
  assert.throws(() => v.voiceBudgetCheck('group:3', lim), /每小时/);
  v.voiceBudgetCommit('group:3', now);
  assert.equal(voiceSendTimes.get('group:3').length, 4, '记账时裁掉超过 1 小时的旧时间戳');
});

await test('slang/window + usage/record: commands are not learned; window is capped; extraction waits for DSH; ledger errors are contained', () => {
  const queued = [];
  const b = { cfg: { slang: { extractMinMessages: 3, extractCooldownMs: 60000 } }, dshReady: false,
    queueSlangTask: (fn) => queued.push(fn), runSlangExtraction: (key) => key };
  const w = Object.assign(b, createSlangWindow(b));
  for (const t of ['/reset', '  ', '切换角色 小明', null]) w.feedSlangWindow('group:1', 'a', t);
  assert.equal(b.slangWindows.has('group:1'), false, '命令 / 空白 / 角色控制语不进学习窗口');
  for (let i = 0; i < 100; i += 1) w.feedSlangWindow('group:1', 'a', `消息${i}`);
  assert.equal(b.slangWindows.get('group:1').length, 80, '窗口封顶 80 条');
  assert.equal(queued.length, 0, 'DSH 未就绪时不排抽取');
  b.dshReady = true;
  w.feedSlangWindow('group:1', 'a', '又一条'); w.feedSlangWindow('group:1', 'a', '再一条');
  assert.equal(queued.length, 1, '冷却期内只排一次');
  assert.equal(queued[0](), 'group:1');
  assert.deepEqual([1, 2, 3].map(() => w.allowSlangSubmit('group:1')), [true, true, false], '每分钟最多 2 次提交');
  assert.equal(w.allowSlangSubmit('group:2'), true);

  const seen = []; const logs = [];
  const u = createUsageRecorder({ cfg: { dsh: { provider: 'p0' } }, log: (...a) => logs.push(a.join(' ')), nominalModel: () => 'nominal',
    rebuildInFlightCollector: () => {},
    tokenLedger: { ingestEvent: (x) => { if (x.event?.boom) throw new Error('boom'); seen.push(x); }, ingestBaseline: (x) => seen.push(x), ingestSnapshotRecords: () => {} } });
  u.recordSessionUsage('s1', { type: 'model/selection', data: { model: 'm1', provider: 'p1' } });
  u.recordSessionUsage('s1', { type: 'assistant/message', data: {} });
  assert.deepEqual([seen[1].model, seen[1].provider], ['m1', 'p1'], '用量按该会话最近一次已知模型记');
  u.recordSessionUsage('s1', { boom: true });
  assert.equal(logs.length, 1, '账本异常只记日志，不影响主链路');
  u.recordSessionSnapshot('s2', { projections: {}, records: [] });
  assert.deepEqual([seen.at(-1).model, seen.at(-1).provider], ['nominal', 'p0'], '未知模型回落到名义模型');
});

// ── 存储 ──
await test('store/initial-prompts: a failed write is rolled back in memory; over-long and bad keys are 400; empty text deletes', () => {
  const dir = tmp();
  const b = { INITIAL_PROMPTS_FILE: path.join(dir, 'initial-prompts.json'), cfg: { socialV2: { initialPromptMaxChars: 100 } },
    initialPrompts: new Map(), initialPromptsWritable: true, log: () => {} };
  const s = createInitialPromptStore(b);
  assert.equal(s.setInitialPrompt('group:abc', 'x').statusCode, 400);
  assert.equal(s.setInitialPrompt('group:1', 'x'.repeat(101)).statusCode, 400);
  const ok = s.setInitialPrompt('group:0012', '﻿这是个\r\n技术群\u0007  ');
  assert.deepEqual([ok.ok, ok.key, ok.entry.text], [true, 'group:12', '这是个\n技术群'], 'key 规范化；行尾统一、去 BOM 与控制字符');
  assert.equal(s.getInitialPrompt('group:12').text, '这是个\n技术群');
  assert.ok(JSON.parse(fs.readFileSync(b.INITIAL_PROMPTS_FILE, 'utf8'))['group:12'], '已落盘');
  b.initialPromptsWritable = false; // 只能只读：接口必须说失败，内存也不能变
  assert.equal(s.setInitialPrompt('group:12', '新内容').statusCode, 500);
  assert.equal(s.getInitialPrompt('group:12').text, '这是个\n技术群', '写失败时内存回滚');
  assert.equal(s.setInitialPrompt('group:12', '').statusCode, 500);
  assert.ok(s.getInitialPrompt('group:12'), '删除失败同样回滚');
  b.initialPromptsWritable = true;
  assert.equal(s.setInitialPrompt('group:12', '   ').deleted, true);
  assert.equal(s.getInitialPrompt('group:12'), null);
});

await test('store/feedback + sessions: tool args are redacted through nested JSON strings; a corrupt sessions.json is never overwritten', () => {
  const dir = tmp();
  const f = createFeedbackStore({ FEEDBACK_FILE: path.join(dir, 'feedback.json'), TOOL_LOG_FILE: path.join(dir, 'tool.log'), log: () => {},
    redactSensitiveText: (t) => String(t).replace(/sk-[a-z0-9]+/g, '[redacted]') });
  const nested = JSON.stringify(JSON.stringify({ key: 'group:1', token: 'abc', inner: { Authorization: 'Bearer x', note: 'sk-deadbeef' }, __proto__x: 1 }));
  const out = f.sanitizeToolArgs(nested);
  assert.ok(!out.includes('abc') && !out.includes('Bearer') && !out.includes('sk-deadbeef') && out.includes('"token":"***"'), out);
  const red = f.redactSensitive(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
  assert.equal(Object.getPrototypeOf(red), null);
  assert.equal({}.polluted, undefined, '脱敏不触发原型链污染');
  assert.equal(f.sanitizeToolArgs(null), null);
  assert.ok(f.sanitizeToolArgs({ text: 'x'.repeat(5000) }).endsWith('…(truncated)'));
  for (let i = 0; i < 505; i += 1) f.appendFeedbackEntry({ message: `m${i} sk-aa11`, at: i });
  const list = f.readFeedbackEntries();
  assert.deepEqual([list.length, list[0].at, list.at(-1).message], [500, 5, 'm504 [redacted]'], '反馈封顶 500 条且落盘前脱敏');

  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, '{"sessions": {"group:1": "s1"');
  const holder = { state: { sessions: {} } };
  const st = createSessionStore({ STATE_FILE: file, log: () => {}, get state() { return holder.state; }, set state(v) { holder.state = v; } });
  st.loadState();
  holder.state.sessions['group:2'] = 's2';
  st.saveState();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"sessions": {"group:1": "s1"', '读坏后只读不写：原文件留给人处理');
});

// ── 权限策略收尾 ──
await test('policy: token fragments are redacted even when split; self-key ids are fresh per rebuild; voice filename audit exempts only owner DM in closed-agent', () => {
  const registry = createAgentTokenRegistry({ max: 8 });
  const a = createTokenAudit({ registry, sensitiveRe: /password\s*=\s*\S+/gi });
  const token = '0123456789abcdef0123456789abcdef';
  a.rememberAgentToken('group:1', token);
  assert.equal(a.hasKnownTokenFragment(`前半段 ${token.slice(0, 16)}`), true, '拆条后的片段也要命中');
  assert.equal(a.hasKnownTokenFragment('普通聊天 0123456'), false);
  assert.equal(a.redactKnownTokensOnly(`t=${token}!`), 't=***!');
  assert.equal(a.redactKnownTokensOnly(`后半段 ${token.slice(16)}`), '***', '只剩片段时整条抹掉');
  assert.equal(a.redactKnownTokensOnly('password=abc'), 'password=abc', '只抹令牌，不动其它敏感词');
  assert.ok(!a.redactSensitiveText(`password=abc ${token}`).includes('abc'));
  a.forgetAgentToken('group:1');
  assert.equal(a.hasKnownTokenFragment(token), false, '会话移除后令牌不再参与脱敏');

  const id1 = encodeSelfKey('group:0456'); const id2 = encodeSelfKey('group:456');
  assert.ok(/^qqb-g-456-[a-f0-9]{32}$/.test(id1) && BOUND_SESSION_ID_RE.test(id1) && id1 !== id2, '前导零归一；每次重建换后缀');
  assert.ok(encodeSelfKey('private:123').startsWith('qqb-p-123-'));
  for (const bad of ['group:abc', 'x:1', '', null]) assert.equal(encodeSelfKey(bad), '');

  const seen = [];
  const b = { currentMode: 'closed-agent', cfg: { ownerQQ: 123 }, hasKnownTokenFragment: (t) => t.includes('TOKEN'),
    log: (m) => seen.push(m), appendActivity: (m) => seen.push(m) };
  b.modeForKey = createConversationPolicy(b).modeForKey;
  const g = createSendGuard(b);
  g.assertOutboundAuditOk('group:1', 'hello.mp3');
  assert.throws(() => g.assertOutboundAuditOk('group:1', 'TOKEN.mp3'), /已阻止发送/);
  assert.equal(seen.length, 2, '拦截时记日志与活动各一条');
  g.assertOutboundAuditOk('private:123', 'TOKEN.mp3'); // closed-agent 下 owner 私聊免审计
  b.currentMode = 'reserved2';
  assert.throws(() => g.assertOutboundAuditOk('private:123', 'TOKEN.mp3'), /已阻止发送/);
});

// ── 会话策略和路由接线 ──
await test('conversations/policy: the closed-agent boundary is decided by session-router and matches the old owner-private rule', () => {
  const { b, p, logs } = policyFixture();
  const keys = ['private:123', 'private:124', 'group:123', 'group:456', 'private:0123', 'private:', 'x:1', ''];
  for (const ownerQQ of [123, '123', null, undefined, '']) {
    const cfg = { ...b.cfg, ownerQQ };
    for (const key of keys) {
      const [kind, id] = key.split(':');
// 以前没配主人 QQ 时会放行空号，现在一律拒绝
      const old = Boolean(ownerQQ) && key === `private:${ownerQQ}`;
      assert.equal(p.modeAllowed(key, kind, Number(id), cfg, 'closed-agent'), old, `owner=${JSON.stringify(ownerQQ)} key=${key}`);
      assert.equal(p.modeForKey(key, 'closed-agent', cfg), old ? 'closed-agent' : null);
      for (const mode of ['chat', 'reserved', 'reserved2']) assert.equal(p.modeForKey(key, mode, cfg), mode, '仿真代际仍是全局设置');
    }
  }
  assert.equal(p.modeAllowed('private:123', 'private', 123, { ...b.cfg, ownerQQ: 'abc' }, 'closed-agent'), false, 'ownerQQ 不合法：fail-closed');
  assert.ok(logs.some((l) => l.includes('会话策略路由初始化失败')));
  b.currentMode = 'closed-agent';
  assert.deepEqual([p.isSessionAllowedInCurrentMode('private:123'), p.isSessionAllowedInCurrentMode('group:456')], [true, false]);
});

// ── 斜杠命令 ──
await test('gateway/snowluma-ws: own messages are dropped, handler errors are logged not thrown, open refreshes identity, close/error trigger token heal', async () => {
  const on = {}; const logs = []; const seen = []; const heals = [];
  const bot = {
    url: 'ws://x', onPrivateMessage: (f) => { on.private = f; }, onGroupMessage: (f) => { on.group = f; },
    onNotice: (t, f) => { on[t] = f; }, onEvent: (f) => { on.event = f; }, onBotStatus: (f) => { on.status = f; },
    on: (t, f) => { on[t] = f; }, getLoginInfo: async () => ({ nickname: 'Bot', user_id: 10002 }),
    connect: async () => { throw new Error('refused'); },
  };
  const b = {
    cfg: { snowluma: { wsUrl: 'ws://cfg' } }, log: (...a) => logs.push(a.join(' ')), snowlumaHealth: {},
    handleIncoming: async (kind, id) => { if (id === 'boom') throw new Error('bad'); seen.push(`${kind}:${id}`); },
    handlePokeNotice: async () => { seen.push('poke'); }, handleRecallNotice: (e) => { seen.push(e.notice_type); },
    noteUpstreamPacket: (label) => { seen.push(label); }, noteReceiveHealth: (good) => { seen.push(`good=${good}`); },
    reportSnowlumaHealth() {}, pollSnowlumaStatus: async () => {}, syncTokenToFile: async () => { seen.push('sync'); },
    healTokenIfStale: async (why) => { heals.push(why); },
  };
  createSnowlumaWs(b).startSnowlumaClient(bot);
  await on.private({ user_id: 10002, self_id: '10002' });
  await on.private({ user_id: 5, self_id: 10002 });
  await on.group({ group_id: 7, user_id: 5, sender: { user_id: '10002' }, self_id: 10002 });
  await on.group({ group_id: 7, user_id: 5, sender: { user_id: 5 }, self_id: 10002 });
  await on.private({ user_id: 'boom', self_id: 10002 });
  await on.group_recall({});
  on.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: false, online: true } });
  on.status({ sub_type: 'offline' });
  assert.deepEqual(seen, ['private:5', 'group:7', 'group_recall', 'meta_event/heartbeat', 'good=false', 'notice/bot_status']);
  assert.equal(b.snowlumaHealth.accountOnline, false);
  assert.ok(logs.some((l) => l.includes('处理私聊消息出错')));
  on.open(); await new Promise((r) => setImmediate(r));
  assert.deepEqual([b.selfNickname, b.selfDisplayName, b.selfUserId, b.snowlumaHealth.connected], ['bot', 'Bot', '10002', true]);
  on.close({ code: 1006 }); on.error({ code: 'E401', message: 'denied' });
  assert.deepEqual(heals, ['close code=1006', 'error E401 | denied']);
  assert.ok(logs.some((l) => l.includes('首次连接未成功')));
});

await test('store/conversations: an invalid file is never overwritten (read-only degrade); a valid one round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-conv-'));
  const file = path.join(dir, 'conversations.json'); const logs = [];
  // 建一个会话设置存储来测
  const mk = () => createConversationStore({ CONVERSATIONS_FILE: file, cfg: { ownerQQ: 123 }, closedAgentPreset: '', resolvePresetName: () => '',
    log: (m) => logs.push(m), appendActivity: () => {} });
  const bad = JSON.stringify({ schemaVersion: 1, conversations: { 'group:1': { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' } } });
  fs.writeFileSync(file, bad);
  const s1 = mk(); s1.loadConversationOverrides();
  assert.deepEqual(s1.listConversationOverrides(), { writable: false, conversations: {} }, '给群指定 closed-agent 的文件整表拒收');
  assert.throws(() => s1.setConversationOverride('group:2', { mode: 'chat' }, 'console'), (e) => !(e instanceof TypeError) && /只读/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), bad, '坏文件原样保留');
  fs.rmSync(file);
  const s2 = mk(); s2.loadConversationOverrides();
  s2.setConversationOverride('group:2', { mode: 'reserved2' }, 'console');
  assert.throws(() => s2.setConversationOverride('group:3', { mode: 'chat' }, 'someone'), TypeError, '只认 console / owner 私聊命令');
  const s3 = mk(); s3.loadConversationOverrides();
  assert.deepEqual(s3.listConversationOverrides().conversations, { 'group:2': { mode: 'reserved2', preset: 'qq-chat-v2', updatedBy: 'console' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('store/pool + slang/pool: slang round-trips losslessly; legacy slang.json is imported once; a corrupt pool is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-pool-'));
  const file = path.join(dir, 'pool', 'items.jsonl'); const legacy = path.join(dir, 'slang.json'); const logs = [];
  // 建一个黑话库存储来测
  const mk = () => createSlangPoolStore({ pool: createMemoryPool({ file }), legacyFile: legacy, log: (m) => logs.push(m) });
  const e = normalizeSlangEntry({ id: 'a', content: 'YYDS', meaning: '永远的神', usage: 'u', example: 'x', risk: 'r', sources: ['s'], status: 'confirmed',
    source: 'manual', scope: 'group:1', count: 3, evidence: [{ key: 'group:1', sender: 'n', text: 't', time: 1 }], lastInferenceCount: 2 });
  assert.deepEqual(poolItemToSlangEntry(slangEntryToPoolItem(e)), e, '词条 ↔ 池条目无损');
  assert.deepEqual([slangEntryToPoolItem(e).kind, slangEntryToPoolItem(e).status, slangEntryToPoolItem(e).conv_id, slangEntryToPoolItem(e).term], ['slang', 'active', 'group:1', 'yyds']);
  assert.deepEqual(mk().loadSlangEntries(), [], '什么都没有 → 空库');
  fs.writeFileSync(legacy, JSON.stringify([e, { id: 'b', content: '芜湖', count: 3 }]));
  assert.deepEqual(mk().loadSlangEntries().map((x) => x.id), ['a', 'b']);
  assert.ok(!fs.existsSync(legacy) && fs.existsSync(`${legacy}.migrated`), '旧文件改名留作备份');
  const s = mk(); const loaded = s.loadSlangEntries();
  assert.deepEqual(loaded[0], e, '重启后从池里读回');
  assert.equal(s.saveSlangEntries([...loaded, { content: '' }, { id: 'c', content: '绝绝子' }], { max: 2 }).dropped, 1, '落盘前裁剪到上限');
  assert.deepEqual(mk().loadSlangEntries().map((x) => x.id), ['a', 'b'], '已确认 / 次数多的优先保留');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${good}{broken\n`);
  const broken = mk();
  assert.throws(() => broken.loadSlangEntries(), /第 4 行损坏/);
  assert.throws(() => broken.saveSlangEntries([]), /损坏/, '池读不出来时不允许写（否则覆盖磁盘）');
  assert.equal(fs.readFileSync(file, 'utf8'), `${good}{broken\n`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('bridge: slash commands are owner-only; /silent and /reset act through the bridge accessors', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, ackMessage: '' } });
  // 造一条指定用户发的群消息
  const ev = (userId, text, id) => ({
    post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456, user_id: userId, message_id: id,
    time: 1762687719, sender: { nickname: 'n', card: 'c' }, message: [{ type: 'text', data: { text } }],
  });
  // 取出所有发出去的消息文字
  const sentTexts = () => h.calls.sent.map((m) => String(m.text));
  const roleFile = path.join(h.temp, 'state', 'current-role.json');
  try {
    h.setMode('reserved2');
    const first = await h.ensureSession('group:456');
    assert.ok(first && h.state.sessions['group:456'] === first);

    // 非管理员的斜杠命令：直接忽略，不回复、不动状态。
    await h.handleIncoming('group', '456', ev(999, '/reset', 1), h.cfg);
    await h.handleIncoming('group', '456', ev(999, '/silent', 2), h.cfg);
    assert.equal(h.state.sessions['group:456'], first, '非管理员不能重置会话');
    assert.equal(fs.existsSync(roleFile) ? JSON.parse(fs.readFileSync(roleFile, 'utf8')).mode : 'active', 'active');
    assert.equal(sentTexts().length, 0);

    // 管理员 /silent：写 current-role.json 并回执。
    await h.handleIncoming('group', '456', ev(123, '/silent', 3), h.cfg);
    assert.equal(JSON.parse(fs.readFileSync(roleFile, 'utf8')).mode, 'silent');
    assert.ok(sentTexts().some((t) => t.includes('已进入静默模式')));
    await h.handleIncoming('group', '456', ev(123, '/active', 4), h.cfg);
    assert.equal(JSON.parse(fs.readFileSync(roleFile, 'utf8')).mode, 'active');

    // 管理员 /reset：清掉映射和旧会话，重建后有新编号
    await h.handleIncoming('group', '456', ev(123, '/reset', 5), h.cfg);
    assert.equal(h.state.sessions['group:456'], undefined, '/reset 撤销会话映射');
    assert.equal(h.state.sessionPolicies['group:456'], undefined);
    assert.ok(h.calls.cancelled.includes(first), '/reset 先停掉旧会话的在途工作');
    assert.ok(h.calls.archived.includes(first), '/reset 归档旧会话');
    assert.ok(sentTexts().some((t) => t.includes('已重置会话')));
    const second = await h.ensureSession('group:456');
    assert.ok(second && second !== first, '重置后建的是新会话');
  } finally { await h.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\nALL PASS');
process.exit(failures ? 1 : 0);
