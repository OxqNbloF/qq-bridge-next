// 代码扫描边界检查：用假时钟和假服务跑真函数
// 不读生产配置，不连 QQ 和 DSH，也不执行外部程序
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { boundedTimerDelay, createAsyncHelpers } from '../src/infra/async.js';
import { createSchedulerV2 } from '../src/features/social-v2/scheduler.js';
import { createSocialLoopV1 } from '../src/features/simulation-v1/loop.js';


// 定时函数用假时钟，调度器在 social-v2/scheduler.js
// b 是它要用的桥接状态，只放这几个调度函数需要的
const realRandom = Math.random;
// 造一套假时钟和调度用的假状态
function timerFixture(random = 0) {
  const timers = [];
  const st = { wakeConfig: {}, recentMessages: [], lastIncomingAt: Date.now() };
  // 调度器用全局 Math.random，按用例把它固定住
  Math.random = () => random;
  // 记录每次定时调用的假定时器
  const fakeSetTimeout = (fn, ms) => {
    const timer = { fn, ms, unref() {} };
    timers.push(timer);
    return timer;
  };
  const b = {
    cfg: { socialV2: { proactive: {} } },
    currentMode: 'reserved2', modeForKey: () => 'reserved2', socialV2: { paused: false, conversations: new Map([['group:456', st]]) },
    state: { sessions: {} }, pendingWakeKeys: new Set(), promptQueues: new Map(), v2TurnStartAt: new Map(),
    collectors: new Map(), turnLeaseNoted: new Set(), activeWaits: new Map(),
    getSocialV2State: () => st,
    isSessionAllowedInCurrentMode: () => true,
    ensureWakeableV2: () => {},
    log() {},
    sendWakePromptV2: async () => {}, deliverPrompt: async () => {},
    setTimeout: fakeSetTimeout, clearTimeout() {},
  };
  const scheduler = createSchedulerV2(b);
  // 一代的 scheduleSocialReply 在 simulation-v1/loop.js
  // 它的 randInt 也用全局 Math.random，上面已经固定
  const loop = createSocialLoopV1({
    cfg: b.cfg, social: { pendingTimers: new Map() }, log() {}, deliverPrompt: async () => {},
    setTimeout: fakeSetTimeout, clearTimeout() {},
  });
  const { sleep } = createAsyncHelpers({ setTimeout: fakeSetTimeout, clearTimeout() {} });
  const context = { fns: { sleep, scheduleSocialReply: loop.scheduleSocialReply } };
  return { ...context.fns, scheduleReplyCheckV2: scheduler.scheduleReplyCheckV2, scheduleWakeV2: scheduler.scheduleWakeV2,
    scheduleProactiveCheckV2: scheduler.scheduleProactiveCheckV2, cfg: b.cfg, st, timers };
}

// 取最后一次定时调用的毫秒数
const latestDelay = (h) => h.timers.at(-1).ms;
// 跑一遍各个定时函数的用例
const runTimerCases = () => {
  const defaults = timerFixture();
  void defaults.sleep(300);
  assert.equal(latestDelay(defaults), 300);
  defaults.scheduleSocialReply('group:456', 'fixture', 2000, 8000, 'fixture');
  assert.equal(latestDelay(defaults), 2000);
  defaults.scheduleReplyCheckV2('group:456');
  assert.equal(latestDelay(defaults), 30000);
  defaults.st.replyCheckTimer = null;
  defaults.scheduleWakeV2('group:456', 'atMention');
  assert.equal(latestDelay(defaults), 8000);
  defaults.scheduleProactiveCheckV2('group:456');
  assert.equal(latestDelay(defaults), 1800000);
  console.log('PASS normal timer defaults remain unchanged');

  for (const zero of [0, '0']) {
    const h = timerFixture(0.5);
    h.cfg.socialV2.autoReplyCheckMs = zero;
    h.scheduleReplyCheckV2('group:456');
    assert.equal(latestDelay(h), 30000, 'zero reply-check delay must retain its default meaning');
    h.st.replyCheckTimer = null;
    h.st.wakeConfig.batchWindowMs = zero;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.equal(latestDelay(h), 8000, 'zero batching delay must retain its default meaning');
    h.cfg.socialV2.proactive = { checkIntervalMinMs: zero, checkIntervalMaxMs: zero };
    h.scheduleProactiveCheckV2('group:456');
    assert.equal(latestDelay(h), 3600000, 'zero proactive min/max must retain the default 30–90 minute range');
  }
  console.log('PASS numeric and string zero preserve the original default intervals');

  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 2 ** 31, -1, 0, 'Infinity', 'bad']) {
    const h = timerFixture();
    void h.sleep(value);
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 0 && latestDelay(h) <= 86400000);
    h.scheduleSocialReply('group:456', 'fixture', value, value, 'fixture');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 0 && latestDelay(h) <= 86400000);
    h.cfg.socialV2.autoReplyCheckMs = value;
    // 两次回复检查加成也不能把已限幅的数值再推出去
    h.st.recentMessages = Array.from({ length: 3 }, () => ({ isSelf: true, time: Date.now(), text: '?' }));
    h.scheduleReplyCheckV2('group:456');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 1000 && latestDelay(h) <= 86400000);
    h.st.replyCheckTimer = null;
    h.st.wakeConfig.batchWindowMs = value;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 1000 && latestDelay(h) <= 3600000);
    const count = h.timers.length;
    h.scheduleWakeV2('group:456', 'atMention');
    assert.equal(h.timers.length, count, 'a pending wake must be coalesced');
    h.cfg.socialV2.proactive = { checkIntervalMinMs: value, checkIntervalMaxMs: value };
    h.scheduleProactiveCheckV2('group:456');
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 60000 && latestDelay(h) <= 86400000);
    h.timers.at(-1).fn();
    assert.ok(Number.isFinite(latestDelay(h)) && latestDelay(h) >= 60000 && latestDelay(h) <= 86400000,
      'recurring proactive checks must never rearm as a 1ms overflow loop');
  }
  console.log('PASS malformed and overflowing delays stay finite and bounded at every scheduler');
  Math.random = realRandom;
};

// 向本地接口发一个假请求
function request(port, pathname, body, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

runTimerCases();
const trustedFfmpeg = 'fixture-local-ffmpeg';
const h = await bridgeHarness({
  config: { socialV2: { voice: { ffmpegPath: trustedFfmpeg, defaultVolume: 1 } } },
  globals: { inspectAudio: async () => ({ ok: true, size: 512, duration: 1, codec: 'mp3', warnings: [] }) },
});
const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
try {
  const rejected = await request(port, '/api/socialV2/config', { voice: { ffmpegPath: 'remote-selected-program', defaultVolume: 2 } });
  assert.equal(rejected.status, 400);
  assert.equal(h.voiceCfg().ffmpegPath, trustedFfmpeg);
  assert.equal(h.cfg.socialV2.voice.defaultVolume, 1, 'rejection must be atomic');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.voice.ffmpegPath, trustedFfmpeg);

  const saved = await request(port, '/api/socialV2/config', { voice: { defaultVolume: 2, maxSeconds: 45 } });
  assert.equal(saved.status, 200);
  assert.equal(h.cfg.socialV2.voice.defaultVolume, 2);
  assert.equal(h.voiceCfg().ffmpegPath, trustedFfmpeg);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.voice.ffmpegPath, trustedFfmpeg);
  console.log('PASS HTTP voice settings cannot select executables and preserve local executable configuration');

  const secret = `Error: private failure at ${path.join(h.temp, 'private.txt')}\n    at privateFunction (private.js:42:1)`;
  h.api.sessions.prompt = async () => { throw new Error(secret); };
  const failed = await request(port, '/api/console/notify-ai', { key: 'group:456', message: 'fixture' });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error, '操作失败，请查看本机 state/bridge.log 排查。');
  assert.ok(!failed.text.includes(h.temp) && !failed.text.includes('privateFunction'));
  const log = fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8');
  assert.ok(log.includes('private failure') && log.includes('privateFunction'), 'operator diagnostics must remain in redacted local logs');

  const invalid = await request(port, '/api/socialV2/wake-config', {});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'key 不能为空');
  h.setReady(false);
  const unavailable = await request(port, '/api/console/notify-ai', { key: 'group:456', message: 'fixture' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error, 'DSH 当前不可用，请稍后再试');
  console.log('PASS internal errors stay in local logs while validation errors remain actionable');

  h.setMode('reserved2');
  h.setReady(true);
  const st = h.getSocialV2State('group:456');
  st.recentMessages.push({ forwardIds: ['fixture-top-forward'] });
  h.bot.raw = async (action, { id }) => {
    assert.equal(action, 'get_forward_msg');
    if (id === 'fixture-top-forward') {
      return { messages: [{ message: [{ type: 'forward', data: { id: 'fixture-nested-forward' } }] }] };
    }
    throw new Error(secret.replace('private failure', 'nested-private failure'));
  };
  const forward = await request(port, '/api/socialV2/forward-message?key=group%3A456&id=fixture-top-forward', undefined, {
    method: 'GET', headers: { 'x-agent-token': st.agentToken },
  });
  assert.equal(forward.status, 200);
  assert.equal(forward.json.ok, true);
  assert.deepEqual(forward.json.nestedPreviews, [{ id: 'fixture-nested-forward', error: '嵌套转发读取失败' }]);
  assert.ok(!forward.text.includes(h.temp) && !forward.text.includes('privateFunction') && !forward.text.includes('nested-private failure'));
  assert.match(fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8'), /nested-private failure/);
  console.log('PASS successful forward responses also hide nested preview exceptions');

  h.cfg.socialV2.tools.sendVoice = true;
  Object.assign(h.cfg.socialV2.voice, { enabled: true, maxPerMinute: 1, maxPerHour: 10 });
  fs.mkdirSync(path.join(h.temp, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(h.temp, 'audio/budget.mp3'), Buffer.alloc(512, 1));
  for (const [pathname, body, headers] of [
    ['/api/voice/send', { target: 'group:456', file: 'budget.mp3', verify: false }, {}],
    ['/api/socialV2/send-voice', { key: 'group:456', voice: 'budget.mp3', verify: false }, { 'x-agent-token': st.agentToken }],
  ]) {
    const sent = await request(port, pathname, body, { headers });
    assert.equal(sent.status, 200, sent.text);
    const limited = await request(port, pathname, body, { headers });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, '语音发送频率超限（每分钟最多 1 条），请稍后再试');
  }
  console.log('PASS operator and agent voice limits retain their specific 429 retry guidance');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}
