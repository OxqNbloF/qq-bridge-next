// 只用假对端和临时文件，不连真的 QQ 或 DSH
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const OTHER = 'group:789';
const config = { slang: { enabled: true, autoResearch: false }, sendDelayMs: 0 };
const slang = [
  { id: 'global', content: '公共词', meaning: '公共解释', status: 'confirmed', scope: 'global' },
  { id: 'own', content: '本群词', meaning: '本群解释', status: 'confirmed', scope: KEY },
  { id: 'other', content: '同名词', meaning: 'other-group-private-meaning', status: 'confirmed', scope: OTHER },
];
const stickers = [{ id: 'scoped-sticker', source: 'manual', url: 'https://public.invalid/sticker',
  noteScope: OTHER, localNote: 'other-group-private-note', tags: ['private-tag'], usage: 'private-usage' }];

// 重新连接会唤醒冷会话，必须先验证有没有权限
{
  const permitted = 'qqb-g-456-0123456789abcdef0123456789abcdef';
  const revoked = 'qqb-g-789-0123456789abcdef0123456789abcdef';
  const privileged = 'qqb-p-123-0123456789abcdef0123456789abcdef';
  const savedState = {
    sessions: { [KEY]: permitted, [OTHER]: revoked, 'private:123': privileged },
    sessionPolicies: {
      [KEY]: JSON.stringify(['chat', 'qq-chat', null]),
      [OTHER]: JSON.stringify(['chat', 'qq-chat', null]),
      'private:123': JSON.stringify(['closed-agent', 'standard', 123]),
    },
  };
  const h = await bridgeHarness({ savedState });
  try {
    assert.deepEqual(h.calls.follows, [], 'startup must not register persisted sessions before checking DSH policy');
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.api.settings.describe = async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
      return { result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' } }] } } };
    };
    h.api.agentPresets = { list: async () => ({ result: { ok: true, value: {
      presets: [{ id: 'standard', isDefault: true }, { id: 'qq-chat' }, { id: 'qq-chat-v2' }],
    } } }) };
    let muxOpened = 0;
    h.api.events.mux = async function* () { muxOpened++; yield { fixture: true }; };
    const first = h.sessionEvents();
    const opening = first.next();
    await started;
    assert.equal(muxOpened, 0, 'cold agents must stay inactive while policy lookup is pending');
    assert.deepEqual(h.calls.follows, []);
    release();
    await opening;
    assert.equal(muxOpened, 1);
    assert.deepEqual(h.calls.follows, [permitted]);
    assert.equal(h.state.sessions[OTHER], undefined, 'removed allowlist entry must retire before follow');
    assert.equal(h.state.sessions['private:123'], undefined, 'old privileged preset must retire before follow');
    assert.ok(h.calls.cancelled.includes(revoked));
    assert.ok(h.calls.cancelled.includes(privileged));
    await first.return();

    // 断线后在 DSH 里改模式，重连时必须读新设置
    h.api.settings.describe = async () => ({ result: { ok: true, value: {
      namespaces: [{ ns: 'qq-mode', value: { mode: 'closed-agent' } }],
    } } });
    h.calls.follows.length = 0;
    const reconnect = h.sessionEvents();
    await reconnect.next();
    assert.equal(muxOpened, 2);
    assert.deepEqual(h.calls.follows, []);
    assert.equal(h.state.sessions[KEY], undefined);
    assert.ok(h.calls.forgotten.includes(permitted));
    await reconnect.return();
    console.log('PASS startup and reconnect validate current DSH policy before activating persisted sessions');
  } finally { await h.close(); }
}

for (const failure of ['mode', 'presets', 'empty-presets']) {
  const h = await bridgeHarness();
  try {
    h.api.settings.describe = async () => {
      if (failure === 'mode') throw new Error('fixture mode unavailable');
      return { result: { ok: true, value: { namespaces: [] } } };
    };
    h.api.agentPresets = { list: async () => {
      if (failure === 'presets') throw new Error('fixture presets unavailable');
      return { result: { ok: true, value: { presets: [] } } };
    } };
    let opened = false;
    h.api.events.mux = async function* () { opened = true; };
    await assert.rejects(h.sessionEvents().next());
    assert.equal(opened, false, 'failed policy refresh must never open an activating stream using cached permissions');
    assert.deepEqual(h.calls.follows, []);
    console.log(`PASS ${failure} lookup failure keeps cold agents inactive`);
  } finally { await h.close(); }
}

// 发一个 HTTP 请求并拿回应
function call(server, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        ...(token ? { 'x-agent-call': '1', 'x-agent-token': token } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

{
  const h = await bridgeHarness({ config, files: { 'state/slang.json': slang, 'state/stickers.json': stickers } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const token = h.getSocialV2State(KEY).agentToken;
    for (const pathname of [`/api/agent/memory?category=term&key=${KEY}`, `/api/agent/prompt?key=${KEY}`]) {
      const res = await call(server, pathname, token);
      assert.equal(res.status, 200, pathname);
      const entries = res.json.items || res.json.terms?.entries;
      assert.equal(entries.length, 2);
      assert.ok(!JSON.stringify(res.json).includes('other-group-private-meaning'));
    }
    const submitted = await call(server, '/api/agent/memory-append', token, { key: KEY, category: 'term', content: '同名词', extra: { meaning: '本群含义' } });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.item.status, 'active');
    assert.ok(!JSON.stringify(submitted.json).includes('other-group-private-meaning'));
    // 黑话存在记忆池里，旧的 slang.json 启动时会导入
    const stored = fs.readFileSync(path.join(h.temp, 'state/pool/items.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l));
    assert.ok(stored.every((e) => e.kind === 'term'));
    assert.equal(stored.filter((e) => e.content === '同名词').length, 2);
    assert.equal(stored.find((e) => e.meaning === 'other-group-private-meaning').conv_id, OTHER);
    assert.ok(fs.existsSync(path.join(h.temp, 'state/slang.json.bak-terms-v2')));

    for (const body of [undefined, { key: KEY, query: '' }]) {
      const res = await call(server, `/api/agent/sticker-list${body ? '' : `?key=${KEY}`}`, token, body);
      assert.equal(res.status, 200);
      const sticker = res.json.stickers.find((e) => e.id === 'scoped-sticker');
      assert.ok(sticker);
      assert.equal(sticker.localNote, '');
      assert.deepEqual(sticker.tags, []);
      assert.equal(sticker.usage, '');
    }
    const search = await call(server, `/api/agent/sticker-list?key=${KEY}&query=private-tag`, token);
    assert.equal(search.json.matched, 0, 'private tags must not become a search oracle');
    const admin = await call(server, '/api/console/stickers');
    assert.equal(admin.json.stickers.find((e) => e.id === 'scoped-sticker').localNote, 'other-group-private-note');
    console.log('PASS scoped slang and sticker HTTP responses exclude other conversations');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

{
  const h = await bridgeHarness({ config });
  try {
    const first = await h.ensureMemoryLearnerSession(KEY);
    assert.equal(await h.ensureMemoryLearnerSession(KEY), first);
    const second = await h.ensureMemoryLearnerSession(OTHER);
    assert.notEqual(second, first, 'changing scope must not reuse model conversation history');
    assert.equal(h.calls.created.length, 2);
    assert.ok(h.calls.forgotten.includes(first), 'retired learner streams must be unsubscribed');
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/memory-session.json'), 'utf8'));
    assert.equal(saved.scope, OTHER);
    console.log('PASS learner model history is replaced when the conversation scope changes');
  } finally { await h.close(); }
}

for (const change of ['pause', 'disable', 'silent']) {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.bot.sendGroupMessage = async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
    };
    const blocker = h.sendToQQ(KEY, 'operator fixture');
    await started;
    const queued = h.sendMessagesV2(KEY, ['queued AI output'], []);
    const rejected = assert.rejects(queued, /AI 已暂停、关闭或进入静默模式/);
    if (change === 'pause') h.socialV2.paused = true;
    if (change === 'disable') h.cfg.socialV2.enabled = false;
    if (change === 'silent') fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ mode: 'silent' }));
    release();
    await blocker;
    await rejected;
    assert.equal(h.calls.http.filter((entry) => /send_group_msg/.test(entry.url)).length, 0);
    console.log(`PASS queued AI sends stop after ${change}`);
  } finally { await h.close(); }
}

for (const change of ['pause', 'disable', 'mode', 'reset']) {
  const h = await bridgeHarness({ config });
  const server = h.startConsoleServer();
  let release;
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const token = h.getSocialV2State(KEY).agentToken;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.bot.getGroupMemberList = async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
      return [{ user_id: 111 }];
    };
    let sent = 0;
    h.bot.raw = async () => { sent++; return {}; };
    const response = call(server, '/api/agent/send-poke', token, { key: KEY, targetUserId: '111' });
    await started;
    if (change === 'pause') h.socialV2.paused = true;
    if (change === 'disable') h.cfg.socialV2.enabled = false;
    if (change === 'mode') h.setMode('chat');
    if (change === 'reset') h.retireSession(KEY);
    release();
    const result = await response;
    assert.notEqual(result.status, 200);
    assert.equal(sent, 0, 'poke must recheck permissions after member lookup');
    console.log(`PASS pending member lookup cannot send a poke after ${change}`);
  } finally {
    release?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// P7.y-B1：每个聊天一个独立目录，可退回共享
{
  const allow = { private: ['123'], groups: ['456', '789'] };
  const h = await bridgeHarness({ config: { allow } });
  try {
    const a = await h.ensureSession(KEY);
    await h.ensureSession(OTHER);
    assert.equal(await h.ensureSession(KEY), a, 'same conversation must reuse its session');
    assert.equal(h.calls.workspaces.length, 2, 'one workspace per conversation, created once');
    const [dirA, dirB] = h.calls.workspaces;
    assert.equal(path.basename(dirA), 'group-456');
    assert.equal(path.basename(dirB), 'group-789');
    assert.equal(path.basename(path.dirname(dirA)), 'agents');
    assert.ok(fs.statSync(dirA).isDirectory() && fs.statSync(dirB).isDirectory());
    assert.deepEqual(h.calls.renames.map((r) => r.title), [`QQ 聊天 · ${KEY}`, `QQ 聊天 · ${OTHER}`]);
    assert.notEqual(h.calls.created[0].workspaceId, h.calls.created[1].workspaceId);
    console.log('PASS per-conversation workspaces are distinct and created once');
  } finally { await h.close(); }
  const shared = await bridgeHarness({ config: { allow, sessionWorkspace: 'shared' } });
  try {
    await shared.ensureSession(KEY);
    await shared.ensureSession(OTHER);
    assert.equal(shared.calls.workspaces.length, 1);
    assert.equal(path.basename(shared.calls.workspaces[0]), 'agents');
    assert.deepEqual(shared.calls.renames.map((r) => r.title), ['QQ 聊天']);
    console.log('PASS sessionWorkspace=shared falls back to one workspace');
  } finally { await shared.close(); }
  const fixedDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qq-fixed-cwd-'));
  const fixed = await bridgeHarness({ config: { allow, sessionCwd: fixedDir } });
  try {
    await fixed.ensureSession(KEY);
    await fixed.ensureSession(OTHER);
    assert.deepEqual(fixed.calls.workspaces, [fixedDir], 'sessionCwd always wins');
    console.log('PASS sessionCwd overrides sessionWorkspace');
  } finally { await fixed.close(); fs.rmSync(fixedDir, { recursive: true, force: true }); }
}
