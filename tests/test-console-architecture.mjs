import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { adaptLegacyConfig, migrateLegacyConfig } from '../src/infra/legacy-config.js';
import { loadConfig } from '../src/infra/config.js';
import { lightMemoryToPoolItems } from '../src/memory/light.js';
import { resolveApiPath } from '../src/policy/api-paths.js';

async function boot(mode = 'reserved2', config = {}, files = {}) {
  const h = await bridgeHarness({ config, files });
  h.setMode(mode);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = async (path, body, agent = false, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken, ...(agent ? { 'x-agent-call': '1', 'x-agent-token': h.getSocialV2State('group:456').agentToken } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { h, call, async close() { await new Promise((resolve) => server.close(resolve)); await h.close(); } };
}
const decode = (file) => loadConfig({ configFile: 'fixture', readJsonSafe: () => file, discoverDshLaunchToken: () => '' });

test('新配置逐字段优先，旧字段补齐，迁移守恒且幂等', () => {
  const input = { ownerQQ: 123, social: { triggerProbability: 0.2 }, socialV2: { wake: { batchWindowMs: 555, maxWakePerMinute: 3 }, tools: { sendVoice: false } }, slang: { enabled: true }, archive: { enabled: true },
    modes: { reserved2: { wake: { batchWindowMs: 888 }, tools: { sendVoice: true } } }, memory: { terms: { enabled: false }, archive: { enabled: false } }, custom: { retained: true } };
  const original = structuredClone(input);
  const cfg = decode(input);
  assert.equal(cfg.socialV2.wake.batchWindowMs, 888);
  assert.equal(cfg.socialV2.wake.maxWakePerMinute, 3);
  assert.equal(cfg.socialV2.tools.sendVoice, true);
  assert.equal(cfg.memory.terms.enabled, false);
  assert.equal(cfg.archive.enabled, false);
  assert.deepEqual(input, original);
  const result = migrateLegacyConfig(input);
  assert.equal(result.changes.length, 4);
  const next = decode(result.config);
  for (const section of ['social', 'socialV2', 'memory', 'archive']) assert.deepEqual(next[section], cfg[section]);
  assert.deepEqual(result.config.custom, { retained: true });
  assert.equal(migrateLegacyConfig(result.config).changes.length, 0);
  assert.equal(adaptLegacyConfig({ socialV2: { agentPreset: 'old' }, modes: { reserved2: { agentPreset: null } } }).socialV2.agentPreset, null);
});

for (const value of [null, [], 'bad']) test(`非法新配置分组 ${JSON.stringify(value)} 拒绝而非静默覆盖`, () => {
  assert.throws(() => decode({ modes: { reserved2: value } }), /必须是对象/);
});

test('只有新命名空间可调度；控制台与工具共用处理器但保留调用身份', () => {
  assert.deepEqual(resolveApiPath('/api/console/scheduler/config'), { namespace: 'console', path: '/api/agent/config' });
  assert.deepEqual(resolveApiPath('/api/console/memory/clear'), { namespace: 'console', path: '/api/agent/memory-clear' });
  assert.deepEqual(resolveApiPath('/api/agent/recent'), { namespace: 'agent', path: '/api/agent/recent' });
  assert.equal(resolveApiPath('/api/console/gate/member-policy/456').namespace, 'console');
  assert.equal(resolveApiPath('/api/status').namespace, 'removed');
});

for (const mode of ['chat', 'reserved', 'reserved2', 'closed-agent']) test(`${mode} 新 Agent API 在旧引擎关闭时也按工具策略校验`, async () => {
  const f = await boot(mode);
  try {
    const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
    const headers = { 'x-agent-call': '1', 'x-agent-token': f.h.getSocialV2State(key).agentToken };
    assert.equal((await f.call(`/api/agent/recent?key=${key}`, null, false, headers)).status, 200);
    assert.equal((await f.call(`/api/agent/recent?key=${key}`, null, false, { ...headers, 'x-agent-call': '0' })).status, 403);
    assert.equal((await f.call(`/api/agent/recent?key=${key}`, null, false, { 'x-agent-call': '1' })).status, 403);
    assert.equal((await f.call(`/api/agent/recent?key=${key === 'group:456' ? 'private:123' : 'group:456'}`, null, false, headers)).status, 403);
    assert.equal((await f.call('/api/console/scheduler/recent?key=' + key, null, false, headers)).status, 403);
    assert.equal((await f.call('/api/agent/settings', null, false, headers)).status, 403);
  } finally { await f.close(); }
});

test('新 Agent 发送也拒绝 decoy，控制台别名和 health 保留鉴权', async () => {
  const f = await boot('reserved', { allow: { groups: ['456', '789'], private: ['123'] } });
  try {
    assert.equal((await f.call('/api/agent/send/group?key=group:456', { key: 'group:456', groupId: '789', message: 'decoy' }, true)).status, 403);
    assert.equal((await f.call('/api/agent/send/group', { groupId: '456', message: '合法工具回复' }, true)).status, 200);
    assert.equal((await f.call('/api/console/sessions')).status, 200);
    assert.equal((await f.call('/api/health')).status, 200);
    assert.equal((await f.call('/api/health', null, false, { 'x-console-token': 'wrong' })).status, 401);
    const status = await f.call('/api/agent/status', null, false, { 'x-agent-call': '1' });
    assert.equal(status.status, 200);
    assert.equal(status.body.ownerQQ, undefined);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1);
  } finally { await f.close(); }
});

test('系统观测只输出队列/租约元数据；Agent 不能读取管理面', async () => {
  const f = await boot('chat', { modes: { engine: { chat: true } } });
  try {
    const token = f.h.getSocialV2State('group:456').agentToken;
    f.h.setReady(false);
    await f.h.deliverPrompt('group:456', '不能出现在观测结果的排队正文');
    const result = await f.call('/api/console/system');
    assert.equal(result.status, 200);
    assert.equal(result.body.scheduler.turns['group:456'].queueDepth, 1);
    assert.ok(!JSON.stringify(result.body).includes(token));
    assert.ok(!JSON.stringify(result.body).includes('不能出现在观测结果的排队正文'));
    f.h.setReady(true); await f.h.turnEngine.replay(); await new Promise(resolve => setImmediate(resolve));
    const active = await f.call('/api/console/system');
    assert.equal(active.body.scheduler.leases.length, 1);
    assert.equal(active.body.scheduler.leases[0].sessionId, f.h.state.sessions['group:456']);
    assert.ok(!JSON.stringify(active.body).includes(token));
    for (const path of ['/api/console/system', '/api/console/settings', '/api/console/identity', '/api/console/memory/long?key=group:456']) assert.equal((await f.call(path, null, true)).status, 403);
  } finally { await f.close(); }
});

test('迁移先预览、校验 revision、备份后写盘；不改变运行中配置', async () => {
  const f = await boot('chat', { social: { triggerProbability: 0.42 }, socialV2: { tools: { sendVoice: false } }, custom: { keep: true } });
  try {
    const file = `${f.h.temp}/config.json`, before = fs.readFileSync(file, 'utf8');
    const settings = await f.call('/api/console/settings');
    assert.equal(JSON.stringify(settings.body).includes('fixture-only'), false);
    const preview = await f.call('/api/console/migration', { revision: settings.body.revision });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const migrated = await f.call('/api/console/migration', { revision: settings.body.revision, apply: true });
    assert.equal(migrated.status, 200, JSON.stringify(migrated));
    assert.deepEqual(JSON.parse(fs.readFileSync(`${f.h.temp}/${migrated.body.backup}`, 'utf8')), JSON.parse(before));
    const next = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(next.social, undefined);
    assert.equal(next.modes.reserved.triggerProbability, 0.42);
    assert.equal(next.custom.keep, true);
    assert.equal((await f.call('/api/console/migration', { revision: settings.body.revision, apply: true })).status, 409);
    assert.equal(f.h.cfg.social.triggerProbability, 0.42);
    const saved = fs.readFileSync(file, 'utf8');
    const repeated = await f.call('/api/console/settings');
    assert.equal(repeated.body.migration.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal((await f.call('/api/console/social', { triggerProbability: 0.31 })).status, 200);
    assert.equal(decode(JSON.parse(fs.readFileSync(file, 'utf8'))).social.triggerProbability, 0.31);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).social, undefined);
  } finally { await f.close(); }
});

test('开关保存先验证，不覆盖未提交配置，不热切换运行中模式', async () => {
  const f = await boot('chat', { socialV2: { tools: { sendVoice: false } } });
  try {
    const settings = (await f.call('/api/console/settings')).body;
    const file = `${f.h.temp}/config.json`, before = fs.readFileSync(file, 'utf8');
    for (const body of [{ modes: [] }, { modes: { engine: { chat: 'true' } } }, { modes: { defaults: { private: 'closed-agent' } } }]) assert.equal((await f.call('/api/console/settings', { revision: settings.revision, ...body, apply: true })).status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal((await f.call('/api/console/settings', { revision: settings.revision, architecture: { gateV2: true }, modes: { engine: { chat: true }, defaults: { group: 'reserved' } }, apply: true })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).architecture.gateV2, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).socialV2, undefined);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).modes.reserved2);
    assert.equal(f.h.cfg.architecture.gateV2, false);
    assert.equal(f.h.cfg.modes.engine.chat, false);
  } finally { await f.close(); }
});

test('身份人工称呼合并、纠错、冲突和删除落盘', async () => {
  const f = await boot();
  try {
    const saved = await f.call('/api/console/identity', { qq: '999', group: '456', name: '老王', aliases: ['王同学', '老王'], expectedUpdatedAt: '' });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.body.people['999'].groups['456'].aliases.length, 2);
    assert.ok(f.h.buildWakePromptV2('group:456', 'bootstrap').includes('老王'));
    assert.equal((await f.call('/api/console/identity', { qq: '999', remove: 'true', expectedUpdatedAt: saved.body.updatedAt })).status, 400);
    assert.ok(f.h.identitySnapshot().people['999']);
    assert.equal((await f.call('/api/console/identity', { qq: '999', name: '过期修改', expectedUpdatedAt: '' })).status, 409);
    assert.equal((await f.call('/api/console/identity', { qq: '999', name: '坏\n名字', expectedUpdatedAt: saved.body.updatedAt })).status, 400);
    assert.equal((await f.call('/api/console/identity', { qq: '999', remove: true, expectedUpdatedAt: saved.body.updatedAt })).status, 400);
    assert.equal((await f.call('/api/console/identity', { qq: '999', remove: true, confirm: true, expectedUpdatedAt: saved.body.updatedAt })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.h.IDENTITY_FILE, 'utf8')).people, {});
  } finally { await f.close(); }
});

test('损坏身份库只读，管理端不能覆盖原始坏文件', async () => {
  const f = await boot('chat', {}, { 'state/identity.json': '{bad' });
  try {
    assert.equal((await f.call('/api/console/identity')).body.writable, false);
    assert.equal((await f.call('/api/console/identity', { qq: '999', name: '新名字', expectedUpdatedAt: '' })).status, 409);
    assert.equal(fs.readFileSync(f.h.IDENTITY_FILE, 'utf8'), '{bad');
  } finally { await f.close(); }
});

test('池内记忆删除绑定会话并确认，其他群与原始聊天不受影响', async () => {
  const f = await boot();
  try {
    f.h.memoryPool.update(() => [{ id: 'one', kind: 'fact', conv_id: 'group:456', content: '本群记忆' }, { id: 'two', kind: 'fact', conv_id: 'group:789', content: '另群记忆' }]);
    assert.equal((await f.call('/api/console/memory/long?key=group:456')).body.items.length, 1);
    assert.equal((await f.call('/api/console/memory/long/delete', { key: 'group:789', id: 'one', confirm: true })).status, 404);
    assert.equal((await f.call('/api/console/memory/long/delete', { key: 'group:456', id: 'one' })).status, 400);
    assert.equal((await f.call('/api/console/memory/long/delete', { key: 'group:456', id: 'one', confirm: true })).status, 200);
    assert.equal(f.h.memoryPool.query().length, 1);
    assert.equal(f.h.memoryPool.query()[0].conv_id, 'group:789');
  } finally { await f.close(); }
});

test('新旧配置部分工具更新都保留默认关闭的能力', async () => {
  assert.equal(Object.hasOwn(adaptLegacyConfig({}), 'socialV2'), false);
  for (const config of [{}, { modes: { reserved2: { enabled: true } } }]) {
    const f = await boot('chat', config);
    try {
      assert.equal((await f.call('/api/console/scheduler/config', { tools: { sendMessage: false } })).status, 200);
      assert.equal(f.h.cfg.socialV2.tools.sendVoice, false);
      assert.equal(f.h.cfg.socialV2.tools.setStickerRemark, false);
      assert.equal(f.h.cfg.socialV2.tools.sendMessage, false);
    } finally { await f.close(); }
  }
});

test('工具失败率只统计结果，不返回日志中的参数或令牌', async () => {
  const f = await boot();
  try {
    fs.writeFileSync(`${f.h.temp}/state/tool-calls.jsonl`, [{ type: 'call', args: '不应泄露的参数' }, { type: 'result', ok: true }, { type: 'result', ok: false }].map(item => JSON.stringify(item)).join('\n'));
    const result = await f.call('/api/console/system');
    assert.deepEqual(result.body.tools, { sample: 2, failed: 1, failureRate: 0.5 });
    assert.ok(!JSON.stringify(result.body).includes('不应泄露的参数'));
  } finally { await f.close(); }
});

test('设置保留未知配置字段，迁移拒绝覆盖非对象父分组', async () => {
  for (const parent of ['memory', 'modes']) assert.throws(() => migrateLegacyConfig({ [parent]: '需要保留的值', slang: { enabled: false } }), /拒绝迁移/);
  const f = await boot('chat', { architecture: { futureFlag: true, schedulerV2: { futureMode: false } }, modes: { engine: { futureMode: true } } });
  try {
    const current = (await f.call('/api/console/settings')).body;
    assert.equal((await f.call('/api/console/settings', { revision: current.revision, architecture: { gateV2: true }, modes: { engine: { chat: true } }, apply: true })).status, 200);
    const saved = JSON.parse(fs.readFileSync(`${f.h.temp}/config.json`, 'utf8'));
    assert.equal(saved.architecture.futureFlag, true);
    assert.equal(saved.architecture.schedulerV2.futureMode, false);
    assert.equal(saved.modes.engine.futureMode, true);
  } finally { await f.close(); }
});

test('P8 旧 URL 不再调度：管理员或有效 Agent 凭据都不能触发旧读写入口', async () => {
  const f = await boot();
  try {
    const before = fs.readFileSync(`${f.h.temp}/config.json`, 'utf8');
    const calls = f.h.calls.http.length;
    for (const path of ['/api/status', '/api/sessions', '/api/slang', '/api/slang/demo/confirm', '/api/socialV2/config', '/api/socialV2/recent', '/api/socialV2/send-message', '/api/send/group', '/api/images/message', '/api/authorize/read']) {
      for (const agent of [false, true]) {
        const read = await f.call(path + '?key=group:456', null, agent);
        assert.equal(read.status, 404, `${path} read`);
        const write = await f.call(path, { key: 'group:456', groupId: '456', message: '旧地址不能发送', tools: { sendVoice: true } }, agent);
        assert.equal(write.status, 404, `${path} write`);
      }
    }
    assert.equal((await f.call('/api/socialV2/config', null, false, { 'x-console-token': 'wrong' })).status, 401);
    assert.equal(fs.readFileSync(`${f.h.temp}/config.json`, 'utf8'), before);
    assert.equal(f.h.calls.http.length, calls, '旧地址不得产生 QQ 或 DSH 调用');
  } finally { await f.close(); }
});

test('P8 状态探测只允许省略 token；空值、无效值及缺 caller 均拒绝', async () => {
  const f = await boot();
  try {
    for (const headers of [{}, { 'x-agent-token': f.h.getSocialV2State('group:456').agentToken }, { 'x-agent-call': '1', 'x-agent-token': '' }, { 'x-agent-call': '1', 'x-agent-token': 'invalid' }]) {
      assert.equal((await f.call('/api/agent/status', null, false, headers)).status, 403);
    }
    const status = await f.call('/api/agent/status', null, false, { 'x-agent-call': '1' });
    assert.equal(status.status, 200);
    for (const field of ['ownerQQ', 'allowGroups', 'allowPrivate', 'activity', 'snowluma']) assert.equal(status.body[field], undefined);
    assert.equal((await f.call('/api/console/status')).status, 200);
    assert.equal((await f.call('/api/console/status', null, true)).status, 403);
  } finally { await f.close(); }
});

test('P8 控制台保存写入新配置键，保留未知字段和新键优先的有效值', async () => {
  const f = await boot('reserved2', { social: { customOption: 7 }, archive: { retentionDays: 5, customArchive: true }, memory: { archive: { retentionDays: 9 } }, custom: { retained: true } });
  try {
    const result = await f.call('/api/console/social', { triggerProbability: 0.12 });
    assert.equal(result.status, 200);
    const file = JSON.parse(fs.readFileSync(`${f.h.temp}/config.json`, 'utf8'));
    for (const key of ['social', 'socialV2', 'slang', 'archive']) assert.equal(Object.hasOwn(file, key), false, key);
    assert.equal(file.modes.reserved.customOption, 7);
    assert.equal(file.modes.reserved.triggerProbability, 0.12);
    assert.equal(file.memory.archive.retentionDays, 9);
    assert.equal(file.memory.archive.customArchive, true);
    assert.deepEqual(file.custom, { retained: true });
    assert.equal(migrateLegacyConfig(file).changes.length, 0);
  } finally { await f.close(); }
});

test('控制台删除 ongoing 与 impression 同步清理实时状态和未认领池缓存，后续保存不再复活', async () => {
  const unclaimedItems = lightMemoryToPoolItems('group:789', {
    activeTopics: [{ text: '未认领待删话题', lastMentionAt: Date.now() }],
    pendingThoughts: [],
    memberImpressions: { '33333': { displayName: '小李', traits: ['喜欢猫'], interactionCount: 1, lastSeenAt: Date.now() } },
  });
  const files = {
    'state/pool/items.jsonl': `${unclaimedItems.map((it) => JSON.stringify(it)).join('\n')}\n`,
  };
  const f = await boot('reserved2', { allow: { groups: ['456', '789'], private: ['123'] } }, files);
  try {
    const st = f.h.getSocialV2State('group:456');
    const now = Date.now();
    st.activeTopics = [{ text: '待删话题', lastMentionAt: now }, { text: '保留话题', lastMentionAt: now }];
    st.pendingThoughts = [{ text: '待删念头', createdAt: now, expiresAt: now + 60000 }];
    st.memberImpressions = { '22222': { displayName: '小王', traits: ['爱喝茶'], interactionCount: 2, lastSeenAt: now } };
    f.h.saveSocialV2State(true);

    const liveItems = f.h.memoryPool.query().filter((it) => it.conv_id === 'group:456');
    const topicItem = liveItems.find((it) => it.kind === 'ongoing' && it.subtype === 'topic' && it.content === '待删话题');
    const thoughtItem = liveItems.find((it) => it.kind === 'ongoing' && it.subtype === 'thought' && it.content === '待删念头');
    const impressionItem = liveItems.find((it) => it.kind === 'impression' && it.subject_uid === '22222');
    assert.ok(topicItem && thoughtItem && impressionItem);

    for (const id of [topicItem.id, thoughtItem.id, impressionItem.id]) {
      const del = await f.call('/api/console/memory/long/delete', { key: 'group:456', id, confirm: true });
      assert.equal(del.status, 200, JSON.stringify(del));
    }
    assert.deepEqual(st.activeTopics.map((t) => t.text), ['保留话题']);
    assert.deepEqual(st.pendingThoughts, []);
    assert.equal(st.memberImpressions['22222'], undefined);
    const promptRes = await f.call('/api/agent/prompt?key=group:456', null, true);
    assert.equal(promptRes.status, 200);
    const promptMem = String(promptRes.body.memory ?? '');
    assert.ok(!promptMem.includes('待删话题') && !promptMem.includes('待删念头') && !promptMem.includes('爱喝茶'));
    assert.ok(promptMem.includes('保留话题'));

    const unclaimedPool = f.h.memoryPool.query().filter((it) => it.conv_id === 'group:789');
    assert.equal(unclaimedPool.length, 2);
    for (const it of unclaimedPool) {
      const del = await f.call('/api/console/memory/long/delete', { key: 'group:789', id: it.id, confirm: true });
      assert.equal(del.status, 200, JSON.stringify(del));
    }

    // 触发新一轮写盘（saveLightMemory），确认已删除的活跃条与未认领缓存条目都不复活
    st.lastActionAt = now + 1;
    f.h.saveSocialV2State(true);
    assert.deepEqual(
      f.h.memoryPool.query().filter((it) => it.conv_id === 'group:456').map((it) => it.content),
      ['保留话题'],
    );
    assert.deepEqual(f.h.memoryPool.query().filter((it) => it.conv_id === 'group:789'), []);

    const claimed = f.h.getSocialV2State('group:789');
    assert.deepEqual(claimed.activeTopics, []);
    assert.deepEqual(claimed.memberImpressions, {});
  } finally { await f.close(); }
});
