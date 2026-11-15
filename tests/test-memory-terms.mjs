import { redactMemoryMigrationBackups, redactMemoryPool, redactActivityLog } from '../src/memory/redact.js';
import { spawnSync } from 'node:child_process';
import { createMessageArchive } from '../src/store/archive.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryPool } from '../src/store/pool.js';
import { createTerms } from '../src/memory/terms.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createParticipationV2 } from '../src/features/social-v2/participation.js';
import { assertMemoryWriteAllowed } from '../src/memory/write-guard.js';
import { createMemoryAPI } from '../src/memory/api.js';
import { createMemoryCompressor } from '../src/memory/compress.js';

test('memory guard checks the full readable window and canonical conversation key', () => {
  const state = { recentMessages: [{ userId: '789' }, ...Array.from({ length: 60 }, () => ({ userId: '123' }))], unread: [] };
  const b = { cfg: { architecture: { gateV2: true } }, socialV2: { conversations: new Map([['group:456', state]]) },
    gateDecide: ({ qq }) => ({ allowed: true, flags: { memory: qq !== '789' } }) };
  for (const key of ['group:456', 'group:0456']) assert.throws(() => assertMemoryWriteAllowed(b, key), { statusCode: 403 });
});

test('memory guard ignores malformed historical actors but audits real denials with stable reasons', () => {
  const audit = [];
  const state = { recentMessages: [{ userId: 'abc' }, { userId: '0' }, { userId: '123' }], unread: [] };
  const b = { cfg: { architecture: { gateV2: true } }, socialV2: { conversations: new Map([['group:456', state]]) },
    appendActivity: text => audit.push(text), log: text => audit.push(text),
    gateDecide: ({ qq }) => ({ allowed: qq === '123', reason: 'bad-sender', flags: { memory: true } }) };
  assert.doesNotThrow(() => assertMemoryWriteAllowed(b, 'group:456'));
  state.recentMessages.push({ userId: '789' });
  b.gateDecide = () => ({ allowed: false, reason: 'blacklisted', flags: { memory: false } });
  assert.throws(() => assertMemoryWriteAllowed(b, 'group:456'), error => error.statusCode === 403 && error.reason === 'blacklisted' && /blacklisted/.test(error.message));
  assert.ok(audit.some(text => text.includes('group:456') && text.includes('blacklisted')));
});

test('memory API validates provenance for every category and passes the canonical key as fifth argument', () => {
  const writes = [];
  const state = { recentMessages: [{ userId: '123', messageId: 'allowed' }], unread: [] };
  const b = { cfg: { architecture: { gateV2: true } }, socialV2: { conversations: new Map([['group:456', state]]) },
    gateDecide: () => ({ allowed: true, flags: { memory: true } }), getSocialV2State: () => state,
    modeAdapterForKey: () => ({ memoryPolicy: { write: ['term', 'alias', 'activeTopic', 'pendingThought', 'memberImpression'] } }),
    terms: { append: (...args) => writes.push(args) }, appendAlias: (...args) => writes.push(args), appendMemoryV2: (...args) => writes.push(args) };
  const api = createMemoryAPI(b);
  for (const category of ['term', 'alias', 'activeTopic', 'pendingThought', 'memberImpression']) {
    assert.throws(() => api.append('group:0456', category, '内容', { target: '123', sourceMessageIds: ['unseen'] }), { statusCode: 403 });
    assert.throws(() => api.append('group:0456', category, '内容', { target: '123', sourceMessageIds: {} }), { statusCode: 400 });
  }
  assert.equal(writes.length, 0);
  api.append('group:0456', 'activeTopic', '内容', { sourceMessageIds: ['allowed'] });
  assert.equal(writes[0][4], 'group:456');
  assert.deepEqual(writes[0][3].sourceMessageIds, ['allowed']);
  assert.throws(() => assertMemoryWriteAllowed(b, 'group:456', { state, sourceMessageIds: ['unseen'] }), { statusCode: 403 });
  state.recentMessages.push({ userId: '789', messageId: 'restricted' });
  b.gateDecide = ({ qq }) => ({ allowed: true, flags: { memory: qq !== '789' } });
  assert.throws(() => api.append('group:456', 'term', '内容', { sourceMessageIds: ['restricted'] }), { statusCode: 403 });
});

test('privacy context reset revokes contaminated history before unblocking term/alias and preserves other scopes', async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let server;
  try {
    h.setMode('reserved2');
    const key = 'group:456', st = h.getSocialV2State(key), token = st.agentToken;
    st.recentMessages.push({ userId: '789', messageId: 'restricted', text: '旧混合正文' });
    st.modelSourceQqs = ['789'];
    st.activeTopics = [{ text: '旧混合派生话题' }];
    h.terms.append(key, '混合词汇', { meaning: '旧解释', source: 'ai' });
    h.terms.append('global', '人工全局', { meaning: '不受影响', source: 'manual' });
    h.terms.append('group:999', '另一群词汇', { meaning: '不受影响', source: 'ai' });
    fs.writeFileSync(h.MEMBER_POLICY_FILE, JSON.stringify({ schemaVersion: 1, groups: { [key]: { mode: 'blacklist', rules: { 789: { flags: {} } } } } }));
    h.loadMemberPolicy();
    assert.throws(() => h.memoryAPI.append(key, 'term', '不能跳过旧来源', { meaning: '不写' }), /成员策略/);
    h.social.pendingSummaries.set(key, { items: [{ text: '不能重放的摘要', userId: '789' }] });
    h.queued.set(key, [{ promptText: '不能重放的旧队列', sourceQqs: ['789'] }]);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const request = (body, agent = false) => fetch(`http://127.0.0.1:${server.address().port}/api/console/session/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken,
        ...(agent ? { 'x-agent-call': '1', 'x-agent-token': token } : {}) },
      body: JSON.stringify({ key, scope: 'privacy-context', ...body }),
    });
    assert.equal((await request({ confirm: true }, true)).status, 403);
    assert.equal((await request({})).status, 400);
    assert.deepEqual(st.modelSourceQqs, ['789'], '未确认不能改状态');
    const cleared = await request({ confirm: true });
    assert.equal(cleared.status, 200, JSON.stringify(await cleared.json()));
    assert.notEqual(st.agentToken, token);
    assert.equal(h.social.pendingSummaries.has(key), false);
    assert.equal(h.queued.has(key), false);
    assert.deepEqual(st.recentMessages, []);
    assert.deepEqual(st.modelSourceQqs, []);
    assert.equal(h.memoryPool.query().some(item => item.conv_id === key), false);
    assert.ok(h.terms.query('global').some(item => item.content === '人工全局'));
    assert.ok(h.terms.query('group:999').some(item => item.content === '另一群词汇'));
    h.appendSocialV2Message(key, '允许成员', '新干净输入', '新干净输入', false, false, 'clean', [], '790');
    assert.doesNotThrow(() => h.memoryAPI.append(key, 'term', '新词汇', { meaning: '可写' }));
    assert.doesNotThrow(() => h.memoryAPI.append(key, 'alias', '新称呼', { target: '790', sourceMessageIds: ['clean'] }));
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('privacy reset of an active session cancels queued work and rejects the old agent token', async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let server;
  try {
    h.setMode('chat');
    await h.deliverPrompt('group:456', '旧模型上下文', { sourceQqs: ['789'] });
    const key = 'group:456', st = h.getSocialV2State(key), token = st.agentToken, sid = h.state.sessions[key];
    const epoch = h.conversationEpoch(key);
    const pending = h.deliverPrompt(key, '排队旧输入', { sourceQqs: ['789'] });
    const cleared = h.memoryAPI.resetContext(key, { confirm: true });
    assert.equal(cleared.retiredSessionId, sid);
    assert.equal(cleared.remoteHistoryDeleted, false);
    assert.equal(h.state.sessions[key], undefined);
    assert.ok(h.conversationEpoch(key) > epoch);
    assert.ok(h.calls.cancelled.includes(sid));
    assert.ok((await pending).queued);
    assert.equal(h.turnEngine.stats(key).queueDepth, 0);
    assert.equal(h.calls.prompts.length, 1, '旧排队输入不得实际交付');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/memory-append`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, 'x-agent-call': '1', 'x-agent-token': token },
      body: JSON.stringify({ key, category: 'term', content: '旧模型不得回写', extra: { meaning: '污染' } }),
    });
    assert.equal(response.status, 403);
    assert.equal(h.terms.query(key).some(item => item.content === '旧模型不得回写'), false);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('partial privacy reset remains durably frozen and can be retried without unblocking old sources', async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let restarted;
  try {
    const key = 'group:456', st = h.getSocialV2State(key);
    st.modelSourceQqs = ['789'];
    h.terms.append(key, '旧词', { meaning: '混合内容', source: 'ai' });
    const update = h.memoryPool.update;
    h.memoryPool.update = () => { throw new Error('fixture disk write denied'); };
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503);
    assert.equal(st.modelSourcesIncomplete, true);
    assert.throws(() => h.memoryAPI.append(key, 'term', '不可解冻', { meaning: '不写' }), /model-sources-incomplete/);
    restarted = await bridgeHarness({ config: { architecture: { gateV2: true } }, files: {
      'state/social-v2.json': fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'),
    } });
    assert.equal(restarted.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.throws(() => restarted.memoryAPI.append(key, 'term', '重启仍冻结', { meaning: '不写' }), /model-sources-incomplete/);
    h.memoryPool.update = update;
    assert.doesNotThrow(() => h.memoryAPI.resetContext(key, { confirm: true }));
    assert.equal(st.modelSourcesIncomplete, false);
  } finally { await restarted?.close(); await h.close(); }
});

test('privacy reset refuses readonly session mapping and preserves its durable freeze across restart', async () => {
  const config = { architecture: { gateV2: true } };
  const key = 'group:456';
  const first = await bridgeHarness({ config });
  let h, restarted;
  try {
    first.setMode('chat');
    const old = await first.ensureSession(key);
    first.saveSocialV2State();
    const savedState = JSON.parse(fs.readFileSync(path.join(first.temp, 'state/sessions.json'), 'utf8'));
    savedState.schemaVersion = 999;
    h = await bridgeHarness({ config, savedState, files: { 'state/social-v2.json': fs.readFileSync(path.join(first.temp, 'state/social-v2.json'), 'utf8') } });
    h.setMode('chat');
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503);
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8')).sessions[key], old);
    restarted = await bridgeHarness({ config, savedState, files: { 'state/social-v2.json': fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8') } });
    assert.equal(restarted.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.throws(() => restarted.memoryAPI.append(key, 'term', '重启不可解冻', { meaning: '不写' }), /model-sources-incomplete/);
  } finally { await restarted?.close(); await h?.close(); await first.close(); }
});

test('privacy reset reports learner unlink failure, remains frozen after restart and succeeds on retry', async t => {
  const config = { architecture: { gateV2: true } }, key = 'group:456';
  const h = await bridgeHarness({ config });
  let restarted, mocked;
  try {
    h.getSocialV2State(key);
    const sid = await h.ensureMemoryLearnerSession(key);
    const file = path.join(h.temp, 'state/memory-session.json');
    const unlink = fs.unlinkSync;
    mocked = t.mock.method(fs, 'unlinkSync', (p, ...args) => {
      if (String(p) === file) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
      return unlink(p, ...args);
    });
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503 && /EACCES/.test(error.message));
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionId, sid);
    restarted = await bridgeHarness({ config, files: {
      'state/memory-session.json': fs.readFileSync(file, 'utf8'),
      'state/social-v2.json': fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'),
    } });
    assert.throws(() => restarted.memoryAPI.append(key, 'alias', '不得回写', { target: '790' }), /model-sources-incomplete/);
    await assert.rejects(h.ensureMemoryLearnerSession(key), /冻结|incomplete/);
    await assert.rejects(restarted.ensureMemoryLearnerSession(key), /冻结|incomplete/);
    mocked.mock.restore();
    h.memoryAPI.resetContext(key, { confirm: true });
    assert.equal(fs.existsSync(file), false);
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, false);
  } finally { mocked?.mock.restore(); await restarted?.close(); await h.close(); }
});

test('privacy reset removes promoted identity aliases on disk and restart while preserving independent and manual identities', async () => {
  const config = { architecture: { gateV2: true } }, key = 'group:456';
  const h = await bridgeHarness({ config });
  let restarted;
  try {
    h.setMode('reserved2'); h.getSocialV2State(key);
    h.appendAlias(key, '秘密代号', { target: '790' });
    for (const message_id of ['identity-e1', 'identity-e2']) await h.handleIncoming('group', 456, {
      message_type: 'group', group_id: 456, user_id: 123, message_id, message: '秘密代号 790', raw_message: '秘密代号 790', sender: { user_id: 123, nickname: 'owner' },
    }, h.cfg);
    h.editIdentity({ qq: '790', group: '456', name: '人工保留', expectedUpdatedAt: h.identitySnapshot().updatedAt ?? '' });
    h.observeResolvedIdentity({ qq: '790', group: '999', name: '独立其他群', source: 'learned', sources: [{ conv: 'group:999', id: 'a' }, { conv: 'group:999', id: 'b' }] });
    h.observeResolvedIdentity({ qq: '790', name: '独立全局', source: 'learned', sources: [{ conv: 'private:790', id: 'a' }, { conv: 'private:790', id: 'b' }] });
    h.flushIdentity();
    assert.equal(h.resolveIdentityAlias({ group: '456', text: '秘密代号' })?.qq, '790');
    h.memoryAPI.resetContext(key, { confirm: true });
    assert.equal(h.resolveIdentityAlias({ group: '456', text: '秘密代号' }), null);
    const saved = fs.readFileSync(h.IDENTITY_FILE, 'utf8');
    assert.doesNotMatch(saved, /秘密代号/);
    restarted = await bridgeHarness({ config, files: { 'state/identity.json': saved } });
    for (const app of [h, restarted]) {
      assert.equal(app.resolveIdentityAlias({ group: '456', text: '秘密代号' }), null);
      assert.equal(app.resolveIdentityAlias({ group: '456', text: '人工保留' })?.qq, '790');
      assert.equal(app.resolveIdentityAlias({ group: '999', text: '独立其他群' })?.qq, '790');
      assert.equal(app.resolveIdentityAlias({ text: '独立全局' })?.qq, '790');
    }
    await h.deliverPrompt(key, '干净提示'); await h.flushQueue();
    assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text, /秘密代号/);
  } finally { await restarted?.close(); await h.close(); }
});

for (const phase of ['learner-create', 'learner-model', 'main-create']) test(`privacy reset rejects in-flight ${phase} without restoring persisted context`, async () => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } },
    files: phase === 'learner-model' ? { 'state/memory-session.json': { preset: 'qq-chat', scope: 'group:999', sessionId: 'saved-other', parked: { 'group:456': 'saved-target' } } } : {} });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  try {
    const key = 'group:456'; h.setMode('chat'); h.getSocialV2State(key);
    const method = phase === 'learner-model' ? 'selectModel' : 'create';
    const original = h.api.sessions[method];
    h.api.sessions[method] = async params => { entered(); await gate; return original(params); };
    const pending = phase === 'main-create' ? h.ensureSession(key) : h.ensureMemoryLearnerSession(key);
    const rejected = assert.rejects(pending, /重置|已作废/);
    await started;
    h.memoryAPI.resetContext(key, { confirm: true });
    release(); await rejected;
    assert.equal(h.state.sessions[key], undefined);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/sessions.json'), 'utf8')).sessions[key], undefined);
  } finally { release(); await h.close(); }
});

test('privacy reset keeps frozen after identity persistence failure and retries cleanup', async t => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let mocked;
  try {
    const key = 'group:456'; h.getSocialV2State(key);
    h.observeResolvedIdentity({ qq: '790', group: '456', name: '待删除身份', source: 'learned' }); h.flushIdentity();
    const original = fs.readFileSync(h.IDENTITY_FILE, 'utf8');
    const rename = fs.renameSync;
    mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === h.IDENTITY_FILE) throw new Error('fixture identity EIO');
      return rename(from, to);
    });
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503);
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.equal(fs.readFileSync(h.IDENTITY_FILE, 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8')).conversations[key].modelSourcesIncomplete, true);
    mocked.mock.restore(); h.memoryAPI.resetContext(key, { confirm: true });
    assert.doesNotMatch(fs.readFileSync(h.IDENTITY_FILE, 'utf8'), /待删除身份/);
  } finally { mocked?.mock.restore(); await h.close(); }
});

test('privacy reset detects a silently skipped session mapping write before thawing', async t => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let mocked;
  try {
    const key = 'group:456'; h.setMode('chat'); const sid = await h.ensureSession(key);
    const file = path.join(h.temp, 'state/sessions.json'), rename = fs.renameSync;
    mocked = t.mock.method(fs, 'renameSync', (from, to) => to === file ? undefined : rename(from, to));
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503);
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[key], sid);
  } finally { mocked?.mock.restore(); await h.close(); }
});

test('privacy reset detects a silently skipped freeze write rather than acknowledging cleanup', async t => {
  const h = await bridgeHarness({ config: { architecture: { gateV2: true } } });
  let mocked;
  try {
    const key = 'group:456'; h.getSocialV2State(key); h.saveSocialV2State();
    const file = path.join(h.temp, 'state/social-v2.json'), rename = fs.renameSync;
    mocked = t.mock.method(fs, 'renameSync', (from, to) => to === file ? undefined : rename(from, to));
    assert.throws(() => h.memoryAPI.resetContext(key, { confirm: true }), error => error.statusCode === 503);
    assert.equal(h.getSocialV2State(key).modelSourcesIncomplete, true);
  } finally { mocked?.mock.restore(); await h.close(); }
});

test('memory API preserves legacy source attribution while member gating is disabled', () => {
  const state = { recentMessages: [{ messageId: 'legacy-without-actor' }], unread: [] };
  let sources;
  const api = createMemoryAPI({ cfg: { architecture: { gateV2: false } }, getSocialV2State: () => state,
    modeAdapterForKey: () => ({ memoryPolicy: { write: ['activeTopic'] } }),
    appendMemoryV2: (st, category, content, extra) => { sources = extra.sourceMessageIds; } });
  api.append('group:456', 'activeTopic', '历史归因');
  assert.deepEqual(sources, ['legacy-without-actor']);
});

test('compressor filters current denied sources, rechecks after await, and rejects denied or unresolved subjects', async () => {
  for (const scenario of ['filter', 'changed', 'subject', 'unresolved']) {
    let denied = new Set(['789']);
    let pool = [], cursor = 0, prompt = '', retired = 0;
    const b = { cfg: { architecture: { gateV2: true }, memory: { enabled: true } },
      messageArchive: { sinceCursor: () => [{ seq: 1, msg_id: 'denied', user_id: '789', from: 'user', plain: '禁止原文' }, { seq: 2, msg_id: 'allowed', user_id: '123', from: 'user', plain: '允许原文' }] },
      compressCursor: { get: () => cursor, set: (key, value) => { cursor = value; } },
      memoryPool: { query: ({ kind }) => pool.filter(item => item.kind === kind), update: fn => { pool = fn(pool); } },
      gateDecide: ({ qq }) => ({ allowed: true, flags: { context: true, memory: !denied.has(qq) } }),
      invalidateMemoryLearnerSession: () => { retired++; }, memoryIndex: { rebuild() {} }, writeMemoryView() {}, log() {},
      sanitizeUntrustedText: text => text, redactKnownTokensOnly: text => text,
      runMemoryLearnerTurn: async (key, content) => {
        prompt = content[0].text;
        if (scenario === 'changed') denied = new Set(['789', '123']);
        return { assertCurrent() {}, output: JSON.stringify([{ kind: 'preference', content: '派生内容', sources: [1], subject: scenario === 'subject' ? '789' : scenario === 'unresolved' ? '未知称呼' : '123' }]) };
      } };
    const result = await createMemoryCompressor(b).compressConversation('group:0456');
    assert.ok(!prompt.includes('禁止原文'), 'memory=false 历史不得进入压缩提示');
    assert.ok(prompt.includes('允许原文'));
    assert.ok(retired > 0, '不能复用含历史上下文的学习会话');
    if (scenario === 'filter') {
      assert.equal(result.ok, true); assert.equal(pool.length, 1); assert.equal(pool[0].conv_id, 'group:456');
      assert.deepEqual(pool[0].source_msg_ids, ['allowed']); assert.equal(cursor, 2);
    } else if (scenario === 'changed') {
      assert.equal(result.ok, false); assert.equal(pool.length, 0); assert.equal(cursor, 0);
    } else { assert.equal(pool.length, 0); }
  }
});

for (const scenario of ['context-filter', 'quoted-context-filter', 'context-changed', 'hard-denial-changed']) test(`R-03 compressor ${scenario} checks context independently of memory`, async () => {
  let restricted = scenario.endsWith('filter');
  let pool = [], cursor = 0, prompt = '';
  const b = { cfg: { architecture: { gateV2: true }, memory: { enabled: true } },
    messageArchive: { sinceCursor: () => [
      { seq: 1, msg_id: 'source-a', user_id: scenario === 'quoted-context-filter' ? '123' : '789', sourceQqs: ['789'], from: 'user', plain: 'context-sensitive' },
      { seq: 2, msg_id: 'source-b', user_id: '123', from: 'user', plain: 'public-source' },
    ] },
    compressCursor: { get: () => cursor, set: (key, value) => { cursor = value; } },
    memoryPool: { query: ({ kind }) => pool.filter(item => item.kind === kind), update: fn => { pool = fn(pool); } },
    gateDecide: ({ qq }) => ({ allowed: !(restricted && qq === '789' && scenario === 'hard-denial-changed'),
      flags: { context: !(restricted && qq === '789'), memory: true } }),
    invalidateMemoryLearnerSession() {}, memoryIndex: { rebuild() {} }, writeMemoryView() {}, log() {},
    sanitizeUntrustedText: text => text, redactKnownTokensOnly: text => text,
    runMemoryLearnerTurn: async (key, content) => {
      prompt = content[0].text;
      restricted = true;
      return { assertCurrent() {}, output: JSON.stringify([{ kind: 'summary', content: 'derived', sources: [] }]) };
    },
  };
  const result = await createMemoryCompressor(b).compressConversation('group:456');
  if (scenario.endsWith('filter')) {
    assert.ok(!prompt.includes('context-sensitive'));
    assert.ok(prompt.includes('public-source'));
    assert.equal(result.ok, true);
    assert.deepEqual(pool[0].source_msg_ids, ['source-b']);
    assert.equal(cursor, 2);
  } else {
    assert.equal(result.ok, false, 'any model input losing context permission invalidates the entire batch');
    assert.match(result.reason, /source-policy-changed/);
    assert.equal(pool.length, 0);
    assert.equal(cursor, 0);
  }
});

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-terms-'));
  const file = path.join(dir, 'items.jsonl');
  const legacyFile = path.join(dir, 'slang.json');
  const pool = createMemoryPool({ file });
  const terms = createTerms({ pool, file, legacyFile, config: () => ({ maxPerConv: 2 }) });
  try { return run({ dir, file, legacyFile, pool, terms }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('migration backs up originals, preserves confirmed scopes and unrelated data, and is idempotent across restart', () => fixture(({ dir, file, legacyFile, pool, terms }) => {
  const old = [{ id: 'confirmed', kind: 'slang', conv_id: 'group:456', status: 'active', content: '好耶', meaning: '开心', mention_count: 3 },
    { id: 'pending', kind: 'slang', conv_id: 'group:789', status: 'candidate', content: '未确认' },
    { id: 'long', kind: 'event', conv_id: 'group:789', content: '保留', status: 'active' }];
  fs.writeFileSync(file, old.map(item => JSON.stringify(item)).join('\n'));
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(legacyFile, JSON.stringify([{ id: 'legacy', content: '通用', meaning: '全局说法', status: 'confirmed' }]));
  const report = terms.migrate();
  assert.equal(report.input, 3); assert.equal(report.converted, 2); assert.equal(report.excluded, 1);
  assert.equal(fs.readFileSync(file + '.bak-terms-v2', 'utf8'), original);
  assert.ok(fs.existsSync(legacyFile + '.bak-terms-v2'));
  assert.equal(terms.query('group:456').length, 2);
  assert.equal(terms.query('group:789').length, 1);
  assert.deepEqual(pool.query({ kind: 'event' }), [old[2]]);
  assert.equal(pool.query({ kind: 'slang' }).length, 0);
  const next = createTerms({ pool: createMemoryPool({ file }), file, legacyFile, config: () => ({}) });
  assert.deepEqual(next.migrate(), report);
  assert.equal(next.query('group:456').length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).schemaVersion, 2);
}));

test('term updates deduplicate within scope, cap only that scope and never erase inherited global entries', () => fixture(({ terms }) => {
  terms.migrate(); terms.append('global', '共有', { meaning: '全局' });
  terms.append('group:456', '专属', { meaning: '旧' });
  terms.append('group:456', '专属', { meaning: '新', usage: '用法' });
  terms.append('group:789', '专属', { meaning: '另一个群' });
  assert.equal(terms.query('group:456').find(item => item.content === '专属').mention_count, 2);
  assert.equal(terms.query('group:789').find(item => item.content === '专属').meaning, '另一个群');
  assert.equal(terms.remove('group:456', '共有'), 0);
  terms.append('group:456', '二', { meaning: '2' }); terms.append('group:456', '三', { meaning: '3' });
  assert.equal(terms.query('group:456').length, 3);
  assert.match(terms.buildContext('group:456'), /【记得的说法】/);
  terms.remove('group:456'); assert.equal(terms.query('group:456').length, 1);
  assert.equal(terms.query('group:789').length, 2);
  assert.throws(() => terms.append('bad', '词', { meaning: '义' }));
  assert.throws(() => terms.append('group:456', '词', {}));
}));

test('corrupt and future data fail closed without backups, writes or success markers', () => fixture(({ dir, file, legacyFile, terms }) => {
  fs.writeFileSync(legacyFile, '{broken');
  assert.throws(() => terms.migrate());
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(dir, '.migrated-terms-v2')), false);
  fs.unlinkSync(legacyFile);
  fs.writeFileSync(file, '{"schemaVersion":999}\n');
  assert.throws(() => createTerms({ pool: createMemoryPool({ file }), file, legacyFile, config: () => ({}) }).migrate(), /高于/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"schemaVersion":999}\n');
}));

for (const mode of ['chat', 'closed-agent', 'reserved', 'reserved2']) test(`${mode}: term HTTP CRUD, token isolation and delivery injection work with memory compression disabled`, async () => {
  const h = await bridgeHarness({ config: { memory: { enabled: false, terms: { enabled: true } } } });
  h.setMode(mode);
  const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (suffix, body, target = key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agent/${suffix}${body ? '' : `?key=${target}&category=term`}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, 'x-agent-call': '1', 'x-agent-token': st.agentToken },
      ...(body ? { body: JSON.stringify({ key: target, category: 'term', ...body }) } : {}),
    }); return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await call('memory-append', { content: '好耶', extra: { meaning: '开心' } })).status, 200);
    assert.equal((await call('memory')).body.items.length, 1);
    assert.equal((await call('memory', null, 'group:789')).status, 403);
    await h.deliverPrompt(key, '怎么说'); await h.flushQueue();
    assert.match(h.calls.prompts.at(-1).content[0].text, /记得的说法[\s\S]*好耶/);
    assert.equal((await call('memory-remove', { content: '好耶' })).body.removed, 1);
    assert.equal((await call('memory')).body.items.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

for (const mode of ['chat', 'closed-agent', 'reserved', 'reserved2']) test(`${mode}: corrupt or future pool never prevents prompt delivery with terms enabled`, async () => {
  for (const broken of ['{broken\n', '{"schemaVersion":999}\n']) {
    const h = await bridgeHarness({ files: { 'state/pool/items.jsonl': broken }, config: { memory: { terms: { enabled: true } } } });
    try {
      h.setMode(mode);
      await h.deliverPrompt(mode === 'closed-agent' ? 'private:123' : 'group:456', '仍然回复');
      await h.flushQueue();
      assert.equal(h.calls.prompts.length, 1);
      assert.equal(fs.readFileSync(path.join(h.temp, 'state/pool/items.jsonl'), 'utf8'), broken);
    } finally { await h.close(); }
  }
});

test('HTTP impression append/update/remove share resolution, opaque refs survive projection, clear preserves other memory and cursor', async () => {
  const h = await bridgeHarness();
  h.setMode('chat');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const call = async (route, body, agent = false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${agent ? 'agent' : 'console'}/${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken,
        ...(agent ? { 'x-agent-call': '1', 'x-agent-token': st.agentToken } : {}) },
      ...(body ? { body: JSON.stringify({ key, ...body }) } : {}),
    }); return { status: response.status, body: await response.json() };
  };
  try {
    h.observeIdentity({ qq: '22222', group: '456', nickname: '小王' });
    assert.equal((await call('memory/append', { category: 'memberImpression', content: '喜欢茶', extra: { target: '小王' } })).status, 200);
    assert.ok(st.memberImpressions['22222']);
    const projected = await call('memory?key=group:456&category=memberImpression', undefined, true);
    assert.equal(projected.status, 200);
    const ref = Object.keys(projected.body.raw.memberImpressions)[0];
    assert.match(ref, /^member-/);
    assert.equal((await call('memory/update', { category: 'memberImpression', target: ref, newContent: '喜欢咖啡' })).status, 200);
    assert.equal(st.memberImpressions['22222'].traits[0], '喜欢咖啡');
    h.observeIdentity({ qq: '33333', group: '456', nickname: '小王' });
    assert.equal((await call('memory/remove', { category: 'memberImpression', target: '小王' })).status, 404);
    assert.ok(st.memberImpressions['22222']);
    assert.equal((await call('memory/remove', { category: 'memberImpression', target: ref })).status, 200);
    assert.equal(Object.keys(st.memberImpressions).length, 0);
    h.cfg.identity.enabled = false;
    assert.equal((await call('memory/append', { category: 'memberImpression', content: '明确QQ', extra: { target: '22222' } })).status, 200);
    h.terms.append(key, '词', { meaning: '含义' });
    h.appendAlias(key, '称呼', { target: '22222' });
    h.memoryPool.update(items => [...items, { id: 'long-clear', kind: 'event', conv_id: key, content: '保留', status: 'active' }]);
    const cursor = h.compressCursor.get(key);
    assert.equal((await call('memory/clear', {})).status, 200);
    assert.equal(Object.keys(st.memberImpressions).length, 0);
    for (const kind of ['term', 'alias', 'event']) assert.equal(h.memoryPool.query({ kind }).length, 1);
    assert.equal(h.compressCursor.get(key), cursor);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('terms reject disabled writes, strip legacy evidence and enforce their own injection budget', () => fixture(({ file, pool, terms }) => {
  fs.writeFileSync(file, JSON.stringify({ id: 'old', kind: 'slang', conv_id: 'group:456', content: '旧词', meaning: '意思', evidence: '隐私原文', status: 'active' }) + '\n');
  terms.migrate();
  assert.equal(pool.query()[0].evidence, undefined);
  const disabled = createTerms({ pool, file, config: () => ({ enabled: false }) });
  assert.throws(() => disabled.append('group:456', '词', { meaning: '义' }), /未启用/);
  terms.append('group:456', '长词', { meaning: '长'.repeat(500), usage: '用'.repeat(300) });
  assert.ok(terms.buildContext('group:456').length < 520);
}));

test('archive-redact CLI removes derived pool, legacy light, index and view while retaining other conversations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-redact-cli-'));
  try {
    const state = path.join(root, 'state');
    const archive = createMessageArchive({ dir: path.join(state, 'archive') });
    archive.append({ conv_id: 'group:456', msg_id: 'secret-1', from: 'user', text: '隐私原文' });
    const pool = createMemoryPool({ file: path.join(state, 'pool/items.jsonl') });
    pool.update(() => [
      { id: 'long', kind: 'event', conv_id: 'group:456', content: '概括', source_msg_ids: ['secret-1'] },
      { id: 'term', kind: 'term', conv_id: 'group:456', content: '词', source_msg_ids: ['secret-1'] },
      { id: 'light', kind: 'ongoing', conv_id: 'group:456', content: '旧话题', source_msg_ids: [] },
      { id: 'alias', kind: 'alias', conv_id: 'group:456', subject_uid: '22222', content: '旧称呼', source_msg_ids: ['secret-1'] },
      { id: 'other', kind: 'event', conv_id: 'group:789', content: '保留', source_msg_ids: ['secret-1'] },
      { id: 'g-term', kind: 'term', conv_id: 'global', content: '全局来源', source_msg_ids: ['secret-1'] },
      { id: 'term:global:migrated', kind: 'term', conv_id: 'global', content: '迁移来源', source_msg_ids: ['secret-1'] },
      { id: 'g-evidence', kind: 'slang', conv_id: 'global', evidence: [{ msg_id: 'secret-1' }] },
    ]);
    const identityFile = path.join(state, 'identity.json');
    fs.writeFileSync(identityFile, JSON.stringify({ people: { '22222': { globalAliases: [{ text: '旧称呼', source: 'learned' }], groups: { '456': { aliases: [{ text: '旧称呼', source: 'learned' }, { text: '人工', source: 'manual' }] } } } } }));
    const socialFile = path.join(state, 'social-v2.json');
    fs.writeFileSync(socialFile, JSON.stringify({ conversations: { 'group:456': { activeTopics: [{ text: '旧隐私' }] }, 'group:789': { activeTopics: [{ text: '保留' }] } } }));
    for (const name of ['views/group-456/memory.md', 'index/group-456.sqlite']) {
      const file = path.join(state, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '隐私');
    }
    const run = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', root, 'group:456', 'secret-1'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(createMemoryPool({ file: path.join(state, 'pool/items.jsonl') }).query().map(item => item.id), ['other']);
    assert.deepEqual(JSON.parse(fs.readFileSync(socialFile, 'utf8')).conversations['group:456'].activeTopics, []);
    assert.equal(JSON.parse(fs.readFileSync(socialFile, 'utf8')).conversations['group:789'].activeTopics.length, 1);
    const person = JSON.parse(fs.readFileSync(identityFile, 'utf8')).people['22222'];
    assert.equal(person.globalAliases.length, 0);
    assert.deepEqual(person.groups['456'].aliases.map(item => item.text), ['人工']);
    assert.equal(fs.existsSync(path.join(state, 'views/group-456/memory.md')), false);
    assert.equal(fs.existsSync(path.join(state, 'index/group-456.sqlite')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt identity still accepts explicit QQ impressions and workspace reset retires current and parked learners', async () => {
  const h = await bridgeHarness({ files: { 'state/identity.json': '{broken' } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    h.getSocialV2State('group:456').recentMessages.push({ userId: '22222', messageId: 'observed-member' });
    assert.equal((await post('memory/append', { key: 'group:456', category: 'memberImpression', content: '喜欢茶', extra: { target: '22222' } })).status, 200);
    const first = await h.ensureMemoryLearnerSession('group:456');
    await h.ensureMemoryLearnerSession('group:789');
    assert.equal((await post('workspace/reset', {})).status, 200);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    assert.notEqual(await h.ensureMemoryLearnerSession('group:456'), first);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/identity.json'), 'utf8'), '{broken');
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('light, terms and long each retain space within a small mode context budget', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true }, memory: { enabled: true } } });
  try {
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    st.activeTopics = Array.from({ length: 10 }, (_, i) => ({ text: `话题${i}` + '长'.repeat(100) }));
    h.terms.append(key, '用词', { meaning: '意'.repeat(500) });
    h.memoryPool.update(items => [...items, { id: 'budget-long', kind: 'event', conv_id: key, content: '长期记忆仍可见', status: 'active', importance: 3 }]);
    const text = h.getMemoryContext(key, st, { read: ['light', 'terms', 'long'], maxChars: 800 });
    assert.ok(text.length <= 800);
    assert.match(text, /话题/); assert.match(text, /记得的说法/); assert.match(text, /长期记忆仍可见/);
  } finally { await h.close(); }
});

for (const [name, files] of Object.entries({
  corruptPool: { 'pool/items.jsonl': '{broken\n' },
  futurePool: { 'pool/items.jsonl': '{"schemaVersion":999}\n' },
  corruptSocial: { 'social-v2.json': '{broken' },
  corruptIdentity: { 'identity.json': '{broken' },
  corruptBackup: { 'pool/items.jsonl.bak-terms-v2': '{broken\n' },
  futureBackup: { 'pool/items.jsonl.bak-terms-v2': '{"schemaVersion":999}\n' },
})) test(`CLI redact completes archive and retires learners despite ${name}, reporting partial cleanup`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-redact-partial-'));
  try {
    const state = path.join(root, 'state');
    const archive = createMessageArchive({ dir: path.join(state, 'archive') });
    archive.append({ conv_id: 'group:456', msg_id: 'secret-1', from: 'user', text: 'secret' });
    fs.writeFileSync(path.join(state, 'memory-session.json'), JSON.stringify({ sessionId: 'old', parked: { 'group:789': 'parked' } }));
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(state, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const run = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', root, 'group:456', 'secret-1'], { encoding: 'utf8' });
    assert.equal(run.status, 4, run.stderr);
    const row = createMessageArchive({ dir: path.join(state, 'archive') }).range('group:456')[0];
    assert.equal(row.redacted, true); assert.equal(row.text, '');
    assert.equal(fs.existsSync(path.join(state, 'memory-session.json')), false);
    assert.match(run.stderr, /清理跳过/); assert.match(run.stderr, /部分完成/);
    for (const [name, text] of Object.entries(files)) {
      if (name.includes('.bak-')) assert.equal(fs.existsSync(path.join(state, name)), false);
      else assert.equal(fs.readFileSync(path.join(state, name), 'utf8'), text);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source redact and slash reset never reuse current or parked memory learners, reset advances conversation epoch', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  try {
    const key = 'group:456';
    h.setMode('chat');
    const first = await h.ensureMemoryLearnerSession(key);
    const parked = await h.ensureMemoryLearnerSession('group:789');
    h.messageArchive.append({ conv_id: key, msg_id: 'private-row', from: 'user', text: '隐私原文' });
    h.messageArchive.redact(key, 'private-row');
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    const next = await h.ensureMemoryLearnerSession(key);
    assert.notEqual(next, first); assert.notEqual(next, parked);
    assert.notEqual(await h.ensureMemoryLearnerSession('group:789'), parked);
    await h.ensureSession(key);
    const epoch = h.conversationEpoch(key);
    await h.handleIncoming('group', 456, { message_type: 'group', group_id: 456, user_id: 123, message_id: 88901,
      sender: { nickname: '管理员' }, message: [{ type: 'text', data: { text: '/reset' } }] }, h.cfg);
    assert.equal(h.conversationEpoch(key), epoch + 1);
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    assert.notEqual(await h.ensureMemoryLearnerSession(key), next);
  } finally { await h.close(); }
});

test('disabled terms reject remove and corrupt console GET returns a safe 503', async () => {
  fixture(({ pool, file }) => {
    const terms = createTerms({ pool, file, config: () => ({ enabled: false }) });
    assert.throws(() => terms.remove('group:456'), /未启用/);
  });
  const h = await bridgeHarness({ files: { 'state/pool/items.jsonl': '{broken\n' } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/memory/terms`, { headers: { 'x-console-token': h.cfg.consoleToken } });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /词汇记忆池不可读/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('redact during learner creation discards the in-flight session instead of persisting it', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const create = h.api.sessions.create;
  h.api.sessions.create = async params => { entered(); await gate; return create(params); };
  try {
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'creating-source', from: 'user', text: 'secret' });
    const pending = h.ensureMemoryLearnerSession('group:456');
    const rejected = assert.rejects(pending, /已作废/);
    await started;
    h.messageArchive.redact('group:456', 'creating-source');
    release(); await rejected;
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    h.api.sessions.create = create;
    assert.ok(await h.ensureMemoryLearnerSession('group:456'));
  } finally { release(); await h.close(); }
});

test('explicit term message sources narrow deletion and survive the tool HTTP boundary', async () => {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/memory/append`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken }, body: JSON.stringify({ key: 'group:456', category: 'term', content: '精确词', extra: { meaning: '意思', sourceMessageIds: ['actual-source'] } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(h.memoryPool.query({ kind: 'term' })[0].source_msg_ids, ['actual-source']);
    assert.throws(() => h.terms.append('group:456', '非法来源', { meaning: '意思', sourceMessageIds: 'bad' }), /来源/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('redact interrupts an active learner wait and prevents old compression results from being written', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true }, memory: { enabled: true } } });
  try {
    const key = 'group:456';
    h.messageArchive.append({ conv_id: key, msg_id: 'waiting-source', from: 'user', text: 'secret' });
    const pending = h.compressConversation(key);
    for (let i = 0; i < 100 && !h.calls.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.calls.prompts.length, 1);
    const old = h.calls.prompts[0].sessionId;
    h.messageArchive.redact(key, 'waiting-source');
    assert.equal((await pending).ok, false);
    assert.equal(h.completeLearnerTurn(old, '[{"kind":"summary","content":"secret"}]'), false);
    assert.equal(h.memoryPool.query({ kind: 'summary' }).length, 0);
    assert.notEqual(await h.ensureMemoryLearnerSession(key), old);
  } finally { await h.close(); }
});


for (const cli of [false, true]) test(`${cli ? 'CLI' : 'in-process'} redact removes unread and recent bodies in memory and on disk, preserving other messages and conversations`, async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  const cliRoot = cli ? fs.mkdtempSync(path.join(os.tmpdir(), 'qq-redact-unread-')) : null;
  try {
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const keep = { messageId: 'keep-1', text: 'keep body' };
    st.recentMessages = [{ messageId: 'secret-1', text: 'secret body' }, keep];
    st.unread = [{ messageId: 'secret-1', text: 'secret body' }, keep];
    const other = h.getSocialV2State('group:789');
    other.unread = [{ messageId: 'secret-1', text: 'other body' }];
    h.saveSocialV2State();
    h.messageArchive.append({ conv_id: key, msg_id: 'secret-1', from: 'user', text: 'secret body' });
    if (cli) {
      fs.cpSync(path.join(h.temp, 'state'), path.join(cliRoot, 'state'), { recursive: true });
      fs.rmSync(path.join(cliRoot, 'state/bridge.lock'));
      const run = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', cliRoot, key, 'secret-1'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    } else {
      assert.equal(h.messageArchive.redact(key, 'secret-1').changed, 1);
      assert.deepEqual(st.recentMessages, [keep]);
      assert.deepEqual(st.unread, [keep]);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(cliRoot ?? h.temp, 'state/social-v2.json'), 'utf8'));
    assert.deepEqual(saved.conversations[key].recentMessages, [keep]);
    assert.deepEqual(saved.conversations[key].unread, [keep]);
    assert.deepEqual(saved.conversations['group:789'].unread, other.unread);
    assert.doesNotMatch(JSON.stringify(saved), /secret body/);
  } finally { if (cliRoot) fs.rmSync(cliRoot, { recursive: true, force: true }); await h.close(); }
});


for (const cli of [false, true]) test(`${cli ? 'CLI' : 'in-process'} privacy redact clears current and rotated activity copies, keeping other conversations`, async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  const cliRoot = cli ? fs.mkdtempSync(path.join(os.tmpdir(), 'qq-redact-activity-')) : null;
  try {
    h.setMode('chat');
    await h.handleIncoming('group', 456, { message_type: 'group', group_id: 456, user_id: 123, message_id: 88911,
      sender: { nickname: '管理员' }, message: [{ type: 'text', data: { text: 'SECRET-ACTIVITY-BODY' } }] }, h.cfg);
    const file = path.join(h.temp, 'state/qq-activity.log');
    assert.match(fs.readFileSync(file, 'utf8'), /SECRET-ACTIVITY-BODY/);
    assert.match(fs.readFileSync(file, 'utf8'), /\[msg:88911\]/);
    const other = '[00:00:00] group:4567 保留其他群\n[00:00:00] private:456 保留私聊\n[00:00:00] [msg:88911] group:789 提及 group:456 仍保留\n[00:00:00] 成员策略 group:456 保留审计状态\n';
    const keepLine = '[00:00:00] [msg:88912] group:456 KEEP-AUDIT-BODY\n';
    fs.appendFileSync(file, keepLine + other);
    const backups = ['social-v2.json.bak-identity-memory', 'pool/items.jsonl.bak-identity-memory', 'pool/items.jsonl.bak-terms-v2', 'slang.json.bak-terms-v2'];
    for (const name of backups) {
      const target = path.join(h.temp, 'state', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{broken SECRET-BACKUP-EVIDENCE');
    }
    fs.writeFileSync(file + '.1', '[00:00:00] group:456（静默）群友：SECRET-ACTIVITY-BODY\n' + keepLine + other);
    if (cli) {
      fs.cpSync(path.join(h.temp, 'state'), path.join(cliRoot, 'state'), { recursive: true });
      fs.rmSync(path.join(cliRoot, 'state/bridge.lock'));
      const run = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', cliRoot, 'group:456', '88911'], { encoding: 'utf8' });
      assert.equal(run.status, 4, run.stderr);
      assert.match(run.stderr, /无法安全解析/);
      const retry = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', cliRoot, 'group:456', '88911'], { encoding: 'utf8' });
      assert.equal(retry.status, 0, retry.stderr);
      assert.match(retry.stdout, /重试清理/);
    } else {
      const result = h.messageArchive.redact('group:456', '88911');
      assert.equal(result.changed, 1);
      assert.equal(result.cleanup.ok, false);
    }
    for (const name of backups) assert.equal(fs.existsSync(path.join(cliRoot ?? h.temp, 'state', name)), false);
    for (const suffix of ['', '.1']) {
      const saved = fs.readFileSync(path.join(cliRoot ?? h.temp, 'state/qq-activity.log') + suffix, 'utf8');
      assert.doesNotMatch(saved, /SECRET-ACTIVITY-BODY/);
      assert.equal(saved, (suffix ? '[00:00:00] group:456 [隐私删除：无来源日志正文已脱敏]\n' : '') + keepLine + other);
    }
  } finally { if (cliRoot) fs.rmSync(cliRoot, { recursive: true, force: true }); await h.close(); }
});


for (const parked of [false, true]) test(`invalidating a ${parked ? 'parked' : 'saved'} learner during model selection rejects reuse`, async () => {
  const preset = 'qq-chat';
  const key = 'group:456';
  const saved = { preset, scope: parked ? 'group:789' : key, sessionId: 'saved-learner', parked: parked ? { [key]: 'parked-learner' } : {} };
  const h = await bridgeHarness({ config: { agentPreset: preset }, files: { 'state/memory-session.json': saved } });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const select = h.api.sessions.selectModel;
  h.api.sessions.selectModel = async params => { entered(); await gate; return select(params); };
  try {
    const pending = h.ensureMemoryLearnerSession(key);
    const rejected = assert.rejects(pending, /已作废/);
    await started;
    h.forgetConversationMemory('group:890');
    release(); await rejected;
    assert.equal(fs.existsSync(path.join(h.temp, 'state/memory-session.json')), false);
    h.api.sessions.selectModel = select;
    assert.notEqual(await h.ensureMemoryLearnerSession(key), parked ? 'parked-learner' : 'saved-learner');
  } finally { release(); await h.close(); }
});


test('valid migration backups keep unrelated conversation rollback data and attributed memories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-redact-backups-'));
  try {
    fs.mkdirSync(path.join(root, 'pool'));
    const social = path.join(root, 'social-v2.json.bak-identity-memory');
    fs.writeFileSync(social, JSON.stringify({ conversations: { 'group:456': { activeTopics: [{ text: 'secret', sourceMessageIds: ['secret-1'] }, { text: 'keep', sourceMessageIds: ['keep-1'] }], recentMessages: [{ messageId: 'secret-1', text: 'secret' }, { messageId: 'keep-1', text: 'keep' }] }, 'group:789': { text: 'keep' } } }));
    for (const name of ['pool/items.jsonl.bak-identity-memory', 'pool/items.jsonl.bak-terms-v2']) {
      fs.writeFileSync(path.join(root, name), [
        { schemaVersion: 2 },
        { id: 'drop', kind: 'term', conv_id: 'group:456', evidence: 'secret', source_msg_ids: ['secret-1'] },
        { id: 'same-conv-keep', kind: 'ongoing', conv_id: 'group:456', source_msg_ids: ['keep-1'], content: 'keep' },
        { id: 'other', kind: 'term', conv_id: 'group:789', evidence: 'keep' },
      ].map(item => JSON.stringify(item)).join('\n'));
    }
    fs.writeFileSync(path.join(root, 'slang.json.bak-terms-v2'), JSON.stringify([{ scope: 'group:456', evidence: 'secret' }, { scope: 'group:789', evidence: 'keep' }]));
    redactMemoryMigrationBackups(root, 'group:456', 'secret-1');
    assert.equal(JSON.parse(fs.readFileSync(social)).conversations['group:789'].text, 'keep');
    const kept = JSON.parse(fs.readFileSync(social)).conversations['group:456'];
    assert.deepEqual(kept.activeTopics.map(item => item.text), ['keep']);
    assert.deepEqual(kept.recentMessages.map(item => item.text), ['keep']);
    for (const name of ['pool/items.jsonl.bak-identity-memory', 'pool/items.jsonl.bak-terms-v2']) {
      const text = fs.readFileSync(path.join(root, name), 'utf8');
      assert.doesNotMatch(text, /secret/);
      assert.deepEqual(text.trim().split('\n').map(line => JSON.parse(line).id).filter(Boolean), ['same-conv-keep', 'other']);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'slang.json.bak-terms-v2'))), [{ scope: 'group:789', evidence: 'keep' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live and backup redaction agree on global sources, evidence and unrelated rollback entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-global-redact-'));
  try {
    fs.mkdirSync(path.join(root, 'pool'));
    const items = [
      { id: 'g-term', kind: 'term', conv_id: 'global', source_msg_ids: ['secret-1'] },
      { id: 'term:global:old', kind: 'term', conv_id: 'global', source_msg_ids: ['secret-1'] },
      { id: 'evidence', kind: 'slang', conv_id: 'global', evidence: [{ message_id: 'secret-1' }] },
      { id: 'independent', kind: 'slang', conv_id: 'global', evidence: [{ message_id: 'other' }] },
      { id: 'other-conv', kind: 'term', conv_id: 'group:789', source_msg_ids: ['secret-1'] },
      { id: 'manual', kind: 'term', conv_id: 'group:456', data: { source: 'manual' } },
      ...['event', 'summary', 'alias'].map(kind => ({ id: kind, kind, conv_id: 'group:456' })),
      { id: 'invalid', kind: 'term', conv_id: 'invalid:scope' },
    ];
    let live = structuredClone(items);
    redactMemoryPool({ update: fn => { live = fn(live); } }, 'group:456', 'secret-1');
    assert.deepEqual(live.map(item => item.id), items.slice(3).map(item => item.id));
    for (const header of [{ schemaVersion: 0 }, { schemaVersion: 2 }]) {
      const backup = path.join(root, 'pool/items.jsonl.bak-terms-v2');
      fs.writeFileSync(backup, '\uFEFF' + [header, ...items].map(item => JSON.stringify(item)).join('\n'));
      redactMemoryMigrationBackups(root, 'group:456', 'secret-1');
      const rows = fs.readFileSync(backup, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(rows.slice(1), live);
    }
    const slang = path.join(root, 'slang.json.bak-terms-v2');
    fs.writeFileSync(slang, '\uFEFF' + JSON.stringify([
      { scope: 'global', source_msg_ids: ['secret-1'] },
      { scope: 'global', source_msg_ids: ['other'] },
      { scope: 'group:456', source: 'manual' },
      { scope: 'invalid:scope' },
    ]));
    redactMemoryMigrationBackups(root, 'group:456', 'secret-1');
    assert.equal(JSON.parse(fs.readFileSync(slang, 'utf8')).length, 3);
    const log = path.join(root, 'qq-activity.log');
    for (const target of [log, log + '.1']) fs.writeFileSync(target, '\uFEFF[12:00:00] [msg:secret-1] group:456 secret\n[12:00:01] [msg:other] group:456 keep\n');
    redactActivityLog(log, 'group:456', 'secret-1');
    for (const target of [log, log + '.1']) {
      assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /secret/);
      assert.match(fs.readFileSync(target, 'utf8'), /keep/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scoped legacy evidence preserves other messages in live pool and migration backups', () => fixture(({ dir, pool }) => {
  const keep = { kind: 'slang', conv_id: 'group:1', evidence: [{ msg_id: '8' }] };
  const drop = { kind: 'slang', conv_id: 'group:1', evidence: [{ msg_id: '7' }] };
  const opaque = { kind: 'slang', conv_id: 'group:1', evidence: 'legacy original text' };
  const empty = { kind: 'slang', conv_id: 'group:1', evidence: [] };
  const unknown = [
    {},
    [{ msg_id: '8' }, 'opaque'],
    ['opaque', { msg_id: '8' }],
    [{ msg_id: '8' }, {}],
    [{ msg_id: '8' }, []],
    [{ msg_id: '7' }, 'opaque'],
  ].map(evidence => ({ kind: 'slang', conv_id: 'group:1', evidence }));
  const items = [keep, drop, opaque, empty, ...unknown];
  pool.update(() => items.map((item, i) => ({ ...item, id: String(i) })));
  redactMemoryPool(pool, 'group:1', '7');
  assert.deepEqual(pool.query().map(item => item.id), ['0']);
  const file = path.join(dir, 'slang.json.bak-terms-v2');
  const legacy = items.map(({ conv_id, ...item }) => ({ ...item, scope: conv_id }));
  fs.writeFileSync(file, JSON.stringify(legacy));
  fs.mkdirSync(path.join(dir, 'pool'));
  const backup = path.join(dir, 'pool/items.jsonl.bak-terms-v2');
  fs.writeFileSync(backup, items.map(item => JSON.stringify(item)).join('\n'));
  redactMemoryMigrationBackups(dir, 'group:1', '7');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [legacy[0]]);
  assert.deepEqual(fs.readFileSync(backup, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [keep]);
}));

test('unreadable backup is preserved, later backups are cleaned and CLI retries remain partial', () => fixture(({ dir }) => {
  const state = path.join(dir, 'state');
  const archive = createMessageArchive({ dir: path.join(state, 'archive') });
  archive.append({ conv_id: 'group:1', msg_id: '7', text: 'secret' });
  const unreadable = path.join(state, 'social-v2.json.bak-identity-memory');
  fs.mkdirSync(unreadable);
  const later = path.join(state, 'slang.json.bak-terms-v2');
  fs.writeFileSync(later, JSON.stringify([{ scope: 'group:1', evidence: [{ msg_id: '7' }] }]));
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', dir, 'group:1', '7'], { encoding: 'utf8' });
    assert.equal(run.status, 4, run.stderr);
    assert.match(run.stderr, /social-v2\.json\.bak-identity-memory 读取失败/);
    assert.equal(fs.statSync(unreadable).isDirectory(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(later, 'utf8')), []);
  }
  assert.equal(createMessageArchive({ dir: path.join(state, 'archive') }).range('group:1')[0].text, '');
  fs.rmdirSync(unreadable);
  const retry = spawnSync(process.execPath, [new URL('../scripts/archive-redact.mjs', import.meta.url).pathname, '--root', dir, 'group:1', '7'], { encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
}));

for (const disappears of [false, true]) test(`backup removal ${disappears ? 'race' : 'failure'} retains parse diagnostics and continues later backups`, t => fixture(({ dir }) => {
  const broken = path.join(dir, 'social-v2.json.bak-identity-memory');
  const later = path.join(dir, 'slang.json.bak-terms-v2');
  fs.writeFileSync(broken, '{broken');
  fs.writeFileSync(later, JSON.stringify([{ scope: 'group:1', evidence: [{ msg_id: '7' }] }]));
  const rmSync = fs.rmSync;
  const mocked = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file !== broken) return rmSync(file, options);
    assert.equal(options.force, true);
    if (disappears) {
      fs.unlinkSync(file);
      return rmSync(file, options);
    }
    throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
  });
  try {
    assert.throws(() => redactMemoryMigrationBackups(dir, 'group:1', '7'), error => {
      assert.match(error.message, /无法安全解析/);
      assert.match(error.message, disappears ? /已移除/ : /移除失败.*fixture EACCES/);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(later, 'utf8')), []);
    assert.equal(fs.existsSync(broken), !disappears);
  } finally { mocked.mock.restore(); }
}));

test('identity write failure reports partial archive cleanup and succeeds on retry', async t => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  let mocked;
  try {
    h.editIdentity({ qq: '22222', name: '保留', expectedUpdatedAt: h.identitySnapshot().updatedAt ?? '' });
    const original = fs.readFileSync(h.IDENTITY_FILE, 'utf8');
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'secret-1', text: 'secret' });
    const renameSync = fs.renameSync;
    mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === h.IDENTITY_FILE) throw Object.assign(new Error('fixture identity write failure'), { code: 'EIO' });
      return renameSync(from, to);
    });
    const result = h.messageArchive.redact('group:456', 'secret-1');
    assert.equal(result.changed, 1);
    assert.equal(result.cleanup.ok, false);
    assert.ok(result.cleanup.errors.some(error => error.includes('身份状态') && error.includes('未保存')));
    assert.equal(h.messageArchive.range('group:456')[0].text, '');
    assert.equal(fs.readFileSync(h.IDENTITY_FILE, 'utf8'), original);
    mocked.mock.restore();
    const retry = h.messageArchive.redact('group:456', 'secret-1');
    assert.equal(retry.changed, 0);
    assert.equal(retry.cleanup.ok, true, JSON.stringify(retry.cleanup));
    assert.equal(JSON.parse(fs.readFileSync(h.IDENTITY_FILE, 'utf8')).people['22222'].globalAliases[0].text, '保留');
  } finally { mocked?.mock.restore(); await h.close(); }
});

test('term source union overflow becomes unknown rather than dropping attribution silently', () => fixture(({ terms, pool }) => {
  terms.append('group:456', '词', { meaning: '义', sourceMessageIds: Array.from({ length: 50 }, (_, i) => String(i)) });
  terms.append('group:456', '词', { meaning: '义', sourceMessageIds: ['extra'] });
  assert.deepEqual(pool.query({ kind: 'term' })[0].source_msg_ids, []);
}));

test('in-process archive cleanup removes sourced global terms including migrated slang', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  try {
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'secret-1', from: 'user', text: 'secret' });
    h.memoryPool.update(items => [...items,
      { id: 'g-term', kind: 'term', conv_id: 'global', content: 'global', source_msg_ids: ['secret-1'] },
      { id: 'old-global', kind: 'slang', conv_id: 'global', content: 'old', meaning: 'meaning', status: 'active', source_msg_ids: ['secret-1'] },
    ]);
    // 独立迁移器没有启动时的成功标记，走真实 slang → term 转换。
    const file = path.join(h.temp, 'state/pool/items.jsonl');
    fs.rmSync(path.join(h.temp, 'state/pool/.migrated-terms-v2'), { force: true });
    createTerms({ pool: h.memoryPool, file, config: () => ({}) }).migrate();
    assert.ok(h.memoryPool.query().some(item => item.id.startsWith('term:global:')));
    const result = h.messageArchive.redact('group:456', 'secret-1');
    assert.equal(result.cleanup.ok, true, JSON.stringify(result.cleanup));
    assert.equal(h.memoryPool.query().some(item => item.source_msg_ids?.includes('secret-1')), false);
  } finally { await h.close(); }
});

test('new and merged light memory share the 50-source bound', async () => {
  const h = await bridgeHarness();
  try {
    const st = h.getSocialV2State('group:456');
    const sources = Array.from({ length: 51 }, (_, i) => `source-${i}`);
    const { appendMemoryV2 } = createParticipationV2({ redactKnownTokensOnly: String, saveSocialV2State() {} });
    appendMemoryV2(st, 'activeTopic', 'new topic', { sourceMessageIds: sources });
    appendMemoryV2(st, 'pendingThought', 'new thought', { sourceMessageIds: sources });
    appendMemoryV2(st, 'memberImpression', 'new impression', { target: '22222', sourceMessageIds: sources });
    assert.deepEqual(st.activeTopics[0].sourceMessageIds, []);
    assert.deepEqual(st.pendingThoughts[0].sourceMessageIds, []);
    assert.deepEqual(st.memberImpressions['22222'].sourceMessageIds, []);
    appendMemoryV2(st, 'activeTopic', 'bounded topic', { sourceMessageIds: sources.slice(0, 50) });
    appendMemoryV2(st, 'activeTopic', 'bounded topic', { sourceMessageIds: sources.slice(50) });
    assert.deepEqual(st.activeTopics.find(item => item.text === 'bounded topic').sourceMessageIds, []);
  } finally { await h.close(); }
});

for (const phase of ['ensure', 'accept', 'result']) test(`cross-conversation invalidation during learner ${phase} prevents stale results and new waits`, async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true }, memory: { enabled: true } } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const prompt = h.api.sessions.prompt;
  if (phase === 'accept') h.api.sessions.prompt = async params => { const value = await prompt(params); await gate; return value; };
  try {
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'source', from: 'user', text: 'secret' });
    if (phase === 'ensure') {
      await h.ensureMemoryLearnerSession('group:456');
      const follow = h.api.events.follow;
      h.api.events.follow = id => { follow(id); queueMicrotask(() => h.forgetConversationMemory('group:789')); };
    }
    const pending = h.compressConversation('group:456');
    if (phase === 'ensure') {
      assert.equal((await pending).ok, false);
      assert.equal(h.calls.prompts.length, 0, 'invalidation between ensure and dispatch must stop the prompt');
      return;
    }
    for (let i = 0; i < 100 && !h.calls.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.calls.prompts.length, 1);
    const sid = h.calls.prompts[0].sessionId;
    if (phase === 'result') assert.equal(h.completeLearnerTurn(sid, '[{"kind":"event","content":"secret","sources":[1]}]'), true);
    h.forgetConversationMemory('group:789');
    release();
    assert.equal((await pending).ok, false);
    assert.equal(h.completeLearnerTurn(sid, '[]'), false);
    assert.equal(h.memoryPool.query({ kind: 'event' }).length, 0);
  } finally { release(); await h.close(); }
});

test('light HTTP source attribution preserves unrelated topics and reports partial in-process redaction', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const append = async (category, content, id) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/memory/append`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken }, body: JSON.stringify({ key: 'group:456', category, content, extra: { sourceMessageIds: [id], meaning: 'meaning' } }) });
    assert.equal(response.status, 200);
  };
  try {
    for (const category of ['activeTopic', 'pendingThought', 'term']) {
      await append(category, 'secret', 'secret-1');
      await append(category, 'keep', 'keep-1');
    }
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'secret-1', text: 'secret' });
    const result = h.messageArchive.redact('group:456', 'secret-1');
    assert.equal(result.changed, 1);
    assert.equal(result.cleanup.ok, true, JSON.stringify(result));
    const st = h.getSocialV2State('group:456');
    assert.deepEqual(st.activeTopics.map(item => item.text), ['keep']);
    assert.deepEqual(st.pendingThoughts.map(item => item.text), ['keep']);
    assert.equal(h.memoryPool.query().some(item => item.content === 'secret'), false);
    assert.equal(h.memoryPool.query().filter(item => item.content === 'keep').length, 3);
    fs.mkdirSync(path.join(h.temp, 'state/qq-activity.log.1'));
    const partial = h.messageArchive.redact('group:456', 'secret-1');
    assert.equal(partial.changed, 0);
    assert.equal(partial.found, true);
    assert.equal(partial.cleanup.ok, false);
    assert.ok(partial.cleanup.errors.some(error => error.includes('活动日志')));
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});


test('source redaction claims unhydrated light memory without erasing unrelated attributed pool entries', async () => {
  const pool = [{ schemaVersion: 2 }, ...['secret-1', 'keep-1'].map(id => ({ id, kind: 'ongoing', subtype: 'topic', conv_id: 'group:456', content: id, source_msg_ids: [id], data: { text: id, lastMentionAt: Date.now() } }))].map(item => JSON.stringify(item)).join('\n');
  const h = await bridgeHarness({ config: { archive: { enabled: true } }, files: { 'state/pool/items.jsonl': pool } });
  try {
    h.messageArchive.append({ conv_id: 'group:456', msg_id: 'secret-1', text: 'secret' });
    assert.equal(h.messageArchive.redact('group:456', 'secret-1').cleanup.ok, true);
    assert.deepEqual(h.getSocialV2State('group:456').activeTopics.map(item => item.text), ['keep-1']);
    assert.deepEqual(h.memoryPool.query({ kind: 'ongoing' }).map(item => item.content), ['keep-1']);
  } finally { await h.close(); }
});
