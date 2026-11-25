// 第二轮全项目深度审阅修复回归测试（离线，无需真实 QQ / DSH / 回环端口）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { projectModelTree } from '../src/identity/project-core.js';
import { createIdentityProjection } from '../src/identity/projection.js';
import { createTimeSenseV2 } from '../src/features/social-v2/time-sense.js';
import { compactModelMessage } from '../src/qq-model-view.js';
import { createSendGuard } from '../src/policy/send-guard.js';
import { assertToolMemberAllowed, TOOL_ROUTES } from '../src/gate/tool.js';
import { createInboundContext } from '../src/inbound/context.js';
import { createOutbox } from '../src/conversations/outbox.js';
import { createTurnEngine } from '../src/scheduler/turn-engine.js';
import { SENSITIVE_RE } from '../src/sensitive.js';
import { hasTokenFragment } from '../src/policy/audit.js';
import { createInstanceLock, parseLockContent } from '../src/infra/lock.js';
import { createRecallHandler } from '../src/inbound/recall.js';
import { stickerForScope } from '../src/sticker-lib.js';
import { syncConfigAliases } from '../src/infra/legacy-config.js';
import { planStop } from '../scripts/stop-bridge-instance.mjs';
import { deepMergePlain, loadConfig } from '../src/infra/config.js';
import { createTokenLedger } from '../src/token-ledger.js';
import { DEFAULT_PRICE_TABLE, resolvePriceTable } from '../src/model-prices.js';
import { normalizeImageForModel } from '../src/media-normalize.js';
import { formatForwardResponse } from '../src/forward.js';

test('P0-1 & P1-3: reserved2 内联快照自动脱敏 QQ/ownerLabel 并附带 memberRef，不误伤英文短语', () => {
  const b = {
    cfg: {
      ownerQQ: '10001',
      identity: { exposeQqInPrompt: false },
      socialV2: { context: { inlineWakeMessages: true, wakeMessageLimit: 10, wakeRecentLimit: 2, wakeMaxChars: 6000 } },
    },
    v2ToolEnabled: () => true,
    identityKnownQqs: () => ['10001', '20002'],
    identityDisplayName: (id, group) => (id === '10001' ? (group === '9001' ? '群主A' : '私聊A') : '群友B'),
    describeAge: () => '刚刚',
    readThroughSeqV2: (st) => st.lastUnreadSeq,
    compactModelMessage,
    getSocialV2State: () => ({
      lastUnreadSeq: 1,
      unread: [{
        seq: 1,
        messageId: 'm1',
        sender: '群主A',
        userId: '10001',
        sourceQqs: ['10001', '20002'],
        isOwner: true,
        ownerLabel: '管理员（ownerQQ 10001）',
        text: 'look at 3 options, format 1, 联系 20002',
        time: Date.now() - 1000,
      }],
      recentMessages: [],
    }),
  };
  Object.assign(b, createIdentityProjection(b));
  const { buildWakeSnapshotV2 } = createTimeSenseV2(b);
  const snap = buildWakeSnapshotV2('group:9001');
  const json = JSON.stringify(snap);
  assert.equal(json.includes('10001'), false, '快照不得包含明文 ownerQQ');
  assert.equal(json.includes('20002'), false, '快照不得包含明文成员 QQ');
  assert.equal(json.includes('ownerLabel'), false, '快照不得包含 ownerLabel');
  assert.equal(json.includes('sourceQqs'), false, '快照不得包含 sourceQqs');
  assert.match(snap.messages[0].memberRef, /^member-[0-9a-f]{16}$/);
  assert.equal(snap.messages[0].text.includes('look at 3 options, format 1'), true, '不得误将英文短语数字替换为群友');
  assert.equal(snap.messages[0].text.includes('群友B'), true, '已知 QQ 仍须脱敏为群内称呼');

  const plainTree = projectModelTree({ text: 'what 2 and stat 200, QQ: 123456789' }, { displayName: () => '群友' });
  assert.equal(plainTree.text, 'what 2 and stat 200, QQ: 群友');
});

test('P0-2: gateV2 旁听成员 (respond=false, context=true) 在历史上下文中不锁死后续正常成员发送', () => {
  const b = {
    cfg: { architecture: { gateV2: true }, socialV2: { enabled: true } },
    selfUserId: '99999',
    socialV2: {
      paused: false,
      conversations: new Map([['group:100', {
        modelSourceQqs: ['11111'], // 旁听成员曾出现在历史上下文中
        recentMessages: [{ userId: '11111', text: 'hi' }],
        unread: [{ userId: '22222', text: '帮我查一下' }], // 本轮触发者是正常成员
      }]]),
    },
    turnEngine: { activeRequest: () => ({ payload: { sourceQqs: ['22222'] } }) },
    state: { sessions: { 'group:100': 's1' } },
    sessionPolicy: () => 'p1',
    conversationEpoch: () => 1,
    isSessionAllowedInCurrentMode: () => true,
    modeForKey: () => 'reserved2',
    readRoleState: () => ({ role: null, mode: 'active' }),
    gateDecide: ({ qq }) => (
      String(qq) === '11111'
        ? { allowed: true, flags: { respond: false, converse: true, context: true, memory: true } }
        : { allowed: true, flags: { respond: true, converse: true, context: true, memory: true } }
    ),
  };
  const { captureSendGuard } = createSendGuard(b);
  assert.doesNotThrow(() => captureSendGuard('group:100', { ai: true })());
  assert.doesNotThrow(() => assertToolMemberAllowed(b, 'group:100', TOOL_ROUTES['POST /api/agent/send-message']));

  // 若本轮触发者自身是 respond=false，仍必须拦截
  b.turnEngine.activeRequest = () => ({ payload: { sourceQqs: ['11111'] } });
  b.socialV2.conversations.get('group:100').unread = [{ userId: '11111', text: 'ping' }];
  assert.throws(() => captureSendGuard('group:100', { ai: true })(), /respond=false/);
});

test('P0-3: resolveReplyTargetV2 通过 getSelfId 支持私聊引用机器人自身消息且空 selfId 不污染负缓存', async () => {
  let currentSelfId = '';
  const bot = {
    async getMessage(id) {
      if (id === 500) return { user_id: 88888, sender: { nickname: '小鲸鱼', user_id: 88888 }, message: [{ type: 'text', data: { text: '我刚说的话' } }] };
      return null;
    },
  };
  const ctx = createInboundContext({ getBot: () => bot, getSelfId: () => currentSelfId, log: () => {} });
  // 刚启动 selfId 尚未拿到时返回 null 但不写负缓存
  assert.equal(await ctx.resolveReplyTargetV2({ recentMessages: [] }, 'private', 12345, '500'), null);
  currentSelfId = '88888';
  const resolved = await ctx.resolveReplyTargetV2({ recentMessages: [] }, 'private', 12345, '500');
  assert.ok(resolved);
  assert.equal(resolved.messageId, '500');
  assert.equal(resolved.info.text, '我刚说的话');
});

test('P0-4: outbox 在底层返回 queued=true 时保持剩余消息顺序并排定续刷定时器', async () => {
  const scheduled = [];
  const delivered = [];
  const b = {
    dshReady: true,
    cfg: {},
    currentMode: 'reserved2',
    modeAllowed: () => true,
    log: () => {},
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; },
    clearTimeout: () => {},
    deliverPrompt: async (_key, text) => {
      delivered.push(text);
      if (text === 'm2') return { ok: true, queued: true };
      return { ok: true };
    },
  };
  const outbox = createOutbox(b);
  outbox.queued.set('group:1', [
    { promptText: 'm1' },
    { promptText: 'm2' },
    { promptText: 'm3' },
  ]);
  await outbox.flushQueue();
  assert.deepEqual(delivered, ['m1', 'm2']);
  assert.deepEqual(outbox.queued.get('group:1').map((x) => x.promptText), ['m3']);
  assert.equal(scheduled.length > 0, true, '必须排定续刷定时器，避免 m3 永久卡死');
});

test('P0-5: turnEngine 对 execute 返回 undefined 兜底 skipped 不锁死租约', async () => {
  const engine = createTurnEngine({
    setTimeout,
    clearTimeout,
    ready: () => true,
    allowed: () => true,
    execute: async () => undefined,
  });
  const res = engine.schedule({
    conv: 'group:1', mode: 'reserved2', epoch: 1,
    trigger: { kind: 'timer', seq: 1, strategy: 'timer', reason: 'timeout' },
    payload: {}, priority: 1, windowMs: 0,
  });
  const outcome = await res.completion;
  assert.equal(outcome.skipped, true);
  assert.equal(engine.stats('group:1').state, 'idle');
});

test('P0-6: lock.js 识别 kind=redact 隐私擦除锁，进程存活时严禁桥接抢锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-lock-r2-'));
  try {
    const lockFile = path.join(dir, 'state', 'bridge.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind: 'redact', root: dir, startedAt: Date.now() }));
    assert.equal(parseLockContent(fs.readFileSync(lockFile, 'utf8'))?.kind, 'redact');
    let exitCode = null;
    const lock = createInstanceLock({
      lockFile,
      configFile: path.join(dir, 'config.json'),
      readJsonSafe: () => ({ consolePort: 3100 }),
      proc: {
        pid: process.pid + 1,
        platform: process.platform,
        kill: () => {},
        exit: (code) => { exitCode = code; throw new Error(`exit:${code}`); },
      },
      execFileSync: () => '', // 端口空闲（archive-redact 不监听端口）
      error: () => {},
    });
    assert.throws(() => lock.acquireLock(), /exit:2/);
    assert.equal(exitCode, 2);
    assert.equal(fs.existsSync(lockFile), true, '不得删除存活的 redact 锁');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-9: 撤回按引用清理 event.message_seq 别名键且不误删本地 m.seq；stickerForScope 空 currentKey 隐藏私有备注', () => {
  const sharedMedia = [{ kind: 'image', url: 'https://example.com/a.png' }];
  const otherMedia = [{ kind: 'image', url: 'https://example.com/other.png' }];
  const convMap = new Map([
    ['msg-100', sharedMedia],
    ['seq-99999', sharedMedia], // event.message_seq 别名键
    ['1', otherMedia],          // 恰好等于本地 m.seq 的另一条消息
  ]);
  const b = {
    convKey: (k, id) => `${k}:${id}`,
    archiveSafely: () => {},
    replyInfoCache: new Map([['group:10:msg-100', { info: {}, ts: Date.now() }]]),
    messageMediaStore: new Map([['group:10', convMap]]),
    social: { recentMessages: new Map(), pendingSummaries: new Map(), silentContext: new Map() },
    socialV2: {
      conversations: new Map([['group:10', {
        recentMessages: [{ seq: 1, messageId: 'msg-100', text: 'secret', media: sharedMedia }],
        unread: [],
      }]]),
    },
    seenForwardIds: new Map(),
    saveSocialV2State: () => true,
    log: () => {},
  };
  const { handleRecallNotice } = createRecallHandler(b);
  assert.equal(handleRecallNotice({ notice_type: 'group_recall', group_id: 10, message_id: 'msg-100' }), true);
  assert.equal(convMap.has('msg-100'), false);
  assert.equal(convMap.has('seq-99999'), false, 'event.message_seq 别名键必须一并清理');
  assert.equal(convMap.has('1'), true, '不得误删无关消息');

  const priv = stickerForScope({ id: 's1', url: 'https://example.com/s.png', localNote: '私聊秘密', noteScope: 'private:123', lastContext: 'ctx' }, '');
  assert.equal(priv.localNote, '', '未传 currentKey 时不得泄露私聊备注');
  assert.equal(priv.lastContext, '');
});

test('P1-3: sensitive.js 不误杀 "选 A: / B" 与 "红包口令是新年快乐"，并拦截 /private/etc/passwd 与分隔符 hex 令牌', () => {
  assert.equal(SENSITIVE_RE.test('选 A: / B 哪个更好？'), false);
  assert.equal(SENSITIVE_RE.test('红包口令是新年快乐'), false);
  assert.equal(SENSITIVE_RE.test('/private/etc/passwd'), true);
  assert.equal(SENSITIVE_RE.test('~/.dsh/credentials.yaml'), true);
  const tok = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(hasTokenFragment('a1b2:c3d4:e5f6:0718', [tok]), true);
  assert.equal(hasTokenFragment(Buffer.from(tok.slice(0, 16), 'hex').toString('base64'), [tok]), true);
});

test('P1-4 & P1-8 & P1-10 & P2-9: 转发 mface、账本滞回基数、syncConfigAliases、stop-bridge 退避守护与配置深合并校验', () => {
  const fwd = formatForwardResponse({
    messages: [{ sender: { nickname: 'U', user_id: 1 }, message: [{ type: 'mface', data: { url: 'https://example.com/m.png', emoji_id: 'e1', summary: '[开心]' } }] }],
  });
  assert.equal(fwd.messages[0].media[0].kind, 'sticker');
  assert.equal(fwd.messages[0].text.includes('开心'), true);

  const synced = syncConfigAliases({ slang: { enabled: true, autoResearch: true }, memory: { terms: { enabled: false } } });
  assert.equal(synced.memory.terms.enabled, false, '新键必须优先于旧键');
  assert.equal('autoResearch' in synced.memory.terms, false, '已弃用旧字段不得复活');

  const stopPlan = planStop({
    port: 3100,
    root: '/repo/qq-bridge-next',
    lockPid: null,
    listenerPid: null,
    processes: [{ pid: 900, parentPid: 1, name: 'bash', commandLine: 'bash /repo/qq-bridge-next/start.sh' }],
  });
  assert.equal(stopPlan.action, 'stop');
  assert.equal(stopPlan.killPid, 900);

  assert.throws(() => deepMergePlain({ wake: { maxWakePerMinute: 1 } }, { wake: null }), TypeError);
  assert.throws(() => loadConfig({ configFile: 'x', readJsonSafe: () => ({ consolePort: -1 }) }), RangeError);

  const pt = resolvePriceTable({ models: { 'deepseek-flash': { off: { cacheHit: 'bad', cacheMiss: -5, output: 1 } } } });
  assert.equal(Number.isFinite(pt.models['deepseek-flash'].off.cacheHit), true);
  assert.equal(pt.models['deepseek-flash'].off.cacheMiss >= 0, true);

  // token-ledger 即使 baselines 数量超过 0.25 * maxLines 也不得复发每事件全量重写
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-ledger-r2-'));
  try {
    let nowMs = Date.parse('2026-03-02T20:00:00+08:00');
    const ledger = createTokenLedger({
      file: path.join(tmpDir, 'ledger.jsonl'),
      priceTable: DEFAULT_PRICE_TABLE,
      resolveKey: () => 'group:1',
      maxLines: 10,
      now: () => ++nowMs,
    });
    for (let i = 0; i < 6; i += 1) {
      ledger.ingestBaseline({
        sessionId: `s${i}`,
        projection: { asOfSeq: 1, values: { tokenUsage: { inputTokens: 100, outputTokens: 10 } } },
        at: nowMs,
      });
    }
    const statBefore = fs.statSync(path.join(tmpDir, 'ledger.jsonl')).ino;
    ledger.ingestEvent({
      sessionId: 's0',
      event: { seq: 2, time: nowMs, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 } } },
      at: nowMs,
    });
    const statAfter = fs.statSync(path.join(tmpDir, 'ledger.jsonl')).ino;
    assert.equal(statAfter, statBefore, '未超滞回水位时不应触发全量原子重写');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P2-5: normalizeImageForModel 关闭 normalize 时仍强制校验 3MiB 硬上限', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 16, 0x41);
  const res = await normalizeImageForModel(big, 'image/png', { enabled: false });
  assert.equal(res.ok, false);
});
