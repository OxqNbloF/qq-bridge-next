// 阶段 1（P0）安全边界与关键正确性修复回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isPrivateIp } from '../src/safe-fetch.js';
import { createInstanceLock } from '../src/infra/lock.js';
import { rejectBadConsoleToken, rejectCsrf } from '../src/infra/http/auth-console.js';
import { loadConfig } from '../src/infra/config.js';
import { createMessageArchive } from '../src/store/archive.js';
import { createTurnEngine } from '../src/scheduler/turn-engine.js';
import { createTimerRegistry } from '../src/scheduler/timer.js';
import { hasTokenFragment, redactText } from '../src/policy/audit.js';
import { SENSITIVE_RE } from '../src/sensitive.js';
import { createVoiceBudget } from '../src/features/voice/budget.js';
import { resolveMemberTarget } from '../src/identity/target.js';
import { createInboundContext } from '../src/inbound/context.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-p0-'));

test('P0-3: isPrivateIp 数值解析拦截压缩 6to4/NAT64/Teredo/Discard 且不误杀公网 IPv6', () => {
  for (const priv of [
    '2002:7f00::1',
    '2002:a00::1',
    '2002:c0a8::1',
    '2002::1',
    '64:ff9b::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '100::1',
    'fc00::1',
    'fd12:3456::1',
    '2001:db8::1',
  ]) {
    assert.equal(isPrivateIp(priv), true, `应拦截内网/保留 IPv6: ${priv}`);
  }
  for (const pub of ['2001:db80::1', 'fc::1', '2002:0808:0808::1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(pub), false, `不应误杀公网 IPv6: ${pub}`);
  }
});

test('P0-1: lock.js 在 macOS 使用 lsof/netstat -anp tcp 并保住存活实例锁', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const lockFile = path.join(dir, 'state', 'bridge.lock');
    fs.writeFileSync(lockFile, '777');
    const cmds = [];
    const exits = [];
    const lock = createInstanceLock({
      lockFile,
      configFile: path.join(dir, 'config.json'),
      readJsonSafe: () => ({ consolePort: 3100 }),
      proc: { pid: 4242, platform: 'darwin', kill: () => true, exit: (c) => { exits.push(c); throw new Error(`exit ${c}`); } },
      execFileSync: (_bin, args) => { cmds.push(args.join(' ')); return 'node 777 user 22u IPv4 0x1 0t0 TCP 127.0.0.1:3100 (LISTEN)'; },
      error: () => {},
    });
    assert.throws(() => lock.acquireLock(), /exit 2/);
    assert.ok(cmds[0].includes('lsof -nP -iTCP:3100'), `macOS 应使用 lsof/netstat -anp tcp，实际: ${cmds[0]}`);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), '777', '存活实例的锁不得被误删');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2: 损坏的 state/social-v2.json 进入只读模式且不会被后续写入清空', async () => {
  const broken = '{corrupt json!!!';
  const h = await bridgeHarness({ files: { 'state/social-v2.json': broken } });
  try {
    assert.ok(h.socialV2.storeReadOnlyReason, '损坏文件必须置位 storeReadOnlyReason');
    h.getSocialV2State('group:456');
    h.saveSocialV2State();
    const onDisk = fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8');
    assert.equal(onDisk, broken, '损坏文件原件不得被覆盖');
  } finally {
    await h.close();
  }
});

test('P0-4: rejectBadConsoleToken 空令牌 fail-closed；rejectCsrf 拒绝伪造 Content-Type 与非 http Origin', () => {
  for (const emptyToken of ['', null, undefined]) {
    let status = 0;
    const rejected = rejectBadConsoleToken({
      req: { method: 'GET', headers: {} },
      res: {},
      url: new URL('http://127.0.0.1:3100/api/console/status'),
      sendJson: (_body, code) => { status = code; },
      consoleToken: emptyToken,
    });
    assert.equal(rejected, true, `空 consoleToken (${String(emptyToken)}) 必须拒绝`);
    assert.equal(status, 401);
  }
  let csrfStatus = 0;
  assert.equal(rejectCsrf({
    req: { method: 'POST', headers: { 'content-type': 'text/plain; application/json' } },
    sendJson: (_b, code) => { csrfStatus = code; },
    boundPort: 3100,
  }), true);
  assert.equal(csrfStatus, 415);
  csrfStatus = 0;
  assert.equal(rejectCsrf({
    req: { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://127.0.0.1:3100' } },
    sendJson: (_b, code) => { csrfStatus = code; },
    boundPort: 3100,
  }), true);
  assert.equal(csrfStatus, 403);
});

test('P0-5 & P0-11: 语音限流规范化前导零 key、支持并发预占，recordVoiceSentV2 写 time 并清沉睡观察', () => {
  const st = {
    recentMessages: [],
    preSleepWaitSatisfiedAt: 123,
    preSleepWaitObservedAt: 456,
    preSleepWaitAccumMs: 789,
    wakeConfig: { noActionCount: 2 },
  };
  let saved = 0;
  const vb = createVoiceBudget({
    cfg: { socialV2: { context: { recentLimit: 50 } } },
    getSocialV2State: () => st,
    saveSocialV2State: () => { saved += 1; },
  });
  const lim = { maxPerMinute: 1, maxPerHour: 10 };
  const release = vb.voiceBudgetReserve('group:0456', lim);
  assert.throws(() => vb.voiceBudgetCheck('group:456', lim), (e) => e instanceof vb.VoiceRateLimitError);
  release();
  vb.voiceBudgetCommit('group:0456');
  assert.throws(() => vb.voiceBudgetCheck('group:456', lim), (e) => e instanceof vb.VoiceRateLimitError);

  vb.recordVoiceSentV2('group:0456', { detail: '1s', messageId: 88 }, '你好');
  assert.equal(st.recentMessages.length, 1);
  assert.equal(typeof st.recentMessages[0].time, 'number');
  assert.equal(st.recentMessages[0].at, undefined);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.preSleepWaitAccumMs, 0);
  assert.equal(saved, 1);
});

test('P0-7: 令牌片段审计与 redactText 拦截零宽/全角/Base64 混淆及 11 字节 Base64 (/etc/passwd)', () => {
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const tokens = new Set([token]);
  const zw = token.slice(0, 8) + '\u200b' + token.slice(8, 20);
  const spaced = token.slice(0, 6) + ' ' + token.slice(6, 18);
  const b64 = Buffer.from(token.slice(0, 16), 'utf8').toString('base64');
  assert.equal(hasTokenFragment(zw, tokens), true, '应拦截零宽字符拆分令牌');
  assert.equal(hasTokenFragment(spaced, tokens), true, '应拦截空格拆分令牌');
  assert.equal(hasTokenFragment(b64, tokens), true, '应拦截 Base64 编码令牌');
  assert.equal(SENSITIVE_RE.test(Buffer.from('/etc/passwd').toString('base64')), true, '应拦截 11 字节 /etc/passwd 的 Base64');
  assert.equal(redactText(`泄露 ${zw}`, tokens, SENSITIVE_RE), '***');
  assert.equal(redactText(`路径 ${Buffer.from('/etc/passwd').toString('base64')}`, tokens, SENSITIVE_RE), '***');
});

test('P0-8 & P0-9: turnEngine 按 epoch 隔离重置后的 turnId；timer.at 不得同步重入', async () => {
  const calls = [];
  const timers = createTimerRegistry({
    now: () => 1000,
    setTimeout: (fn, ms) => { calls.push({ fn, ms }); return { id: calls.length }; },
    clearTimeout: () => {},
  });
  let ranSync = false;
  timers.at('k', 500, () => { ranSync = true; });
  assert.equal(ranSync, false, 'until <= now 时不得在 at() 中同步执行回调');
  assert.equal(calls.length, 1);
  calls[0].fn();
  assert.equal(ranSync, true);

  const runs = [];
  const pendingTimers = new Set();
  const engine = createTurnEngine({
    now: () => 1000,
    setTimeout: (fn) => { const h = { fn }; pendingTimers.add(h); return h; },
    clearTimeout: (h) => { pendingTimers.delete(h); },
    execute: async (req) => { runs.push(req); return { ok: true }; },
  });
  const r1 = engine.schedule({ conv: 'group:456', mode: 'reserved2', epoch: 0, trigger: { kind: 'message', strategy: 'immediate', seq: 1, reason: 'msg' }, payload: {} });
  await r1.completion;
  engine.finish('group:456', r1.turnId);
  const r1Dup = engine.schedule({ conv: 'group:456', mode: 'reserved2', epoch: 0, trigger: { kind: 'message', strategy: 'immediate', seq: 1, reason: 'msg' }, payload: {} });
  assert.equal(r1Dup.status, 'dropped');
  const r2AfterReset = engine.schedule({ conv: 'group:456', mode: 'reserved2', epoch: 1, trigger: { kind: 'message', strategy: 'immediate', seq: 1, reason: 'msg' }, payload: {} });
  assert.equal(r2AfterReset.status, 'accepted', 'epoch 递增后 seq=1 不得撞上旧墓碑');
  await r2AfterReset.completion;
  assert.equal(runs.length, 2);
});

test('P0-10: loadConfig 深合并 socialV2 嵌套配置，局部覆盖不抹同级默认限流', () => {
  const cfg = loadConfig({
    configFile: 'fixture.json',
    readJsonSafe: () => ({
      socialV2: { wake: { maxWakePerHour: 20 }, send: { maxSendPerMinute: 4 } },
      social: { triggerProbability: 0.25 },
    }),
    discoverDshLaunchToken: () => '',
  });
  assert.equal(cfg.socialV2.wake.maxWakePerHour, 20);
  assert.equal(cfg.socialV2.wake.maxWakePerMinute, 1, '同级默认 maxWakePerMinute 不得丢失');
  assert.equal(cfg.socialV2.wake.preSleepWaitMs, 300000, '同级默认 preSleepWaitMs 不得丢失');
  assert.equal(cfg.socialV2.send.maxSendPerMinute, 4);
  assert.equal(cfg.socialV2.send.maxSendPerHour, 60, '同级默认 maxSendPerHour 不得丢失');
  assert.equal(cfg.social.triggerProbability, 0.25);
  assert.equal(cfg.social.maxReplyChars, 500);
});

test('P0-6: resolveMemberTarget 对裸 QQ 也执行 gateV2 可见性与私聊边界校验', async () => {
  const b = {
    cfg: { architecture: { gateV2: true } },
    gateDecide: ({ qq }) => qq === '222'
      ? { allowed: true, flags: { respond: true, converse: true, context: true, memory: true } }
      : { allowed: false, reason: 'blacklisted', flags: { respond: false, converse: false, context: false, memory: false } },
  };
  assert.equal(await resolveMemberTarget(b, 'group:456', '222'), '222');
  await assert.rejects(() => resolveMemberTarget(b, 'group:456', '999'), (e) => e.statusCode === 403);
  await assert.rejects(() => resolveMemberTarget(b, 'private:222', '333'), (e) => e.statusCode === 403);
});

test('P0-11: resolveReplyTargetV2 透传 selfId 使私聊引用机器人自身消息成功', async () => {
  const ctx = createInboundContext({
    getBot: () => ({
      selfId: 10002,
      getMessage: async () => ({
        user_id: 10002,
        sender: { user_id: 10002, nickname: '小鲸鱼' },
        message: [{ type: 'text', data: { text: '我刚才说的' } }],
      }),
    }),
    log: () => {},
    segmentsToText: async (segs) => segs.map((s) => s?.data?.text ?? '').join(''),
  });
  const resolved = await ctx.resolveReplyTargetV2({ recentMessages: [] }, 'private', 12345, '778899');
  assert.ok(resolved);
  assert.equal(resolved.messageId, '778899');
  assert.equal(resolved.info.userId, '10002');
});

test('P0-11: archive.open() 恢复超过 13 万行大分片不发生调用栈溢出', () => {
  const dir = mkTmp();
  try {
    const convDir = path.join(dir, 'group_456');
    fs.mkdirSync(convDir, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 135000; i += 1) {
      lines.push(`{"v":1,"seq":${i},"ts":1700000000000,"type":"message","msg_id":"m${i}","text":"x"}`);
    }
    fs.writeFileSync(path.join(convDir, '2026-11-01.jsonl'), lines.join('\n') + '\n', 'utf8');
    const archive = createMessageArchive({ dir, idWindow: 200 });
    const res = archive.append({ conv_id: 'group:456', msg_id: 'm135001', text: 'next' });
    assert.equal(res.seq, 135001);
    const dup = archive.append({ conv_id: 'group:456', msg_id: 'm135000', text: 'dup' });
    assert.equal(dup.duplicate, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
