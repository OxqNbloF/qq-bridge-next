// 工作台全模块参数注册表、校验、热更新与静态资源路径边界离线回归测试
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODULE_DEFINITIONS, buildModuleCatalog, validateModulePatch, applyHotModuleChanges } from '../src/features/console/module-registry.js';
import { resolveApiPath } from '../src/policy/api-paths.js';
import { SOCIAL_V2_TOOL_FLAGS } from '../src/policy/tool-defaults.js';

test('全部 12 模块参数注册表无重复路径且覆盖全部 29 项工具开关与关键模块', () => {
  assert.equal(MODULE_DEFINITIONS.length, 12);
  const paths = MODULE_DEFINITIONS.flatMap((m) => m.fields.map((f) => f.path));
  assert.equal(new Set(paths).size, paths.length, '模块参数路径不得重复');
  for (const required of [
    'ackMessage', 'dsh.model', 'snowluma.silenceWarnMs', 'ignore.sendQQ',
    'architecture.schedulerV2.maxConcurrent', 'modes.reserved.triggerProbability',
    'modes.reserved2.wake.staleChatMinutes', 'modes.reserved2.media.maxLongEdge',
    'role.injectEveryNWakes', 'memory.archive.retentionDays', 'identity.exposeQqInPrompt',
    'webSearch.timeoutMs', 'pricing', 'security.interceptNotify',
  ]) {
    assert.equal(paths.includes(required), true, `必须覆盖参数 ${required}`);
  }
  for (const flag of SOCIAL_V2_TOOL_FLAGS) {
    assert.equal(paths.includes(`modes.reserved2.tools.${flag}`), true, `必须覆盖工具 ${flag}`);
  }
});

test('buildModuleCatalog 绝不回显 secret 明文，并准确标记 pendingRestart', () => {
  const cfg = {
    dsh: { authToken: 'super-secret-dsh-token', baseUrl: 'http://127.0.0.1:3080', model: 'deepseek-flash' },
    webSearch: { apiKey: 'sk-secret-search-key', provider: 'auto', timeoutMs: 35000 },
    architecture: { gateV2: false, schedulerV2: { maxConcurrent: 4 } },
  };
  const fileConfig = {
    dsh: { authToken: 'super-secret-dsh-token', baseUrl: 'http://127.0.0.1:3099' },
    webSearch: { apiKey: 'sk-secret-search-key' },
    architecture: { schedulerV2: { maxConcurrent: 8 } },
  };
  const catalog = buildModuleCatalog({ cfg, fileConfig });
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes('super-secret-dsh-token'), false, '不得回显 dsh.authToken');
  assert.equal(serialized.includes('sk-secret-search-key'), false, '不得回显 webSearch.apiKey');
  const dshMod = catalog.modules.find((m) => m.id === 'dsh');
  const tokField = dshMod.fields.find((f) => f.path === 'dsh.authToken');
  assert.equal(tokField.configured.configured, true);
  assert.equal(dshMod.fields.find((f) => f.path === 'dsh.baseUrl').pendingRestart, true);
  assert.equal(catalog.pendingRestartCount >= 2, true);
});

test('validateModulePatch 拒绝 localOnly 字段、未知路径与越界数值，并自动归一化 min<=max', () => {
  assert.throws(() => validateModulePatch({
    moduleId: 'sticker-voice',
    values: { 'modes.reserved2.voice.ffmpegPath': '/tmp/evil' },
    currentFile: {},
  }), /仅可在部署机/);

  assert.throws(() => validateModulePatch({
    moduleId: 'sticker-voice',
    values: { 'modes.reserved2.voice.dir': '/etc' },
    currentFile: {},
  }), /仅可在部署机/);

  assert.throws(() => validateModulePatch({
    moduleId: 'media',
    values: { 'modes.reserved2.media.maxLongEdge': 999999 },
    currentFile: {},
  }), /不能大于/);

  assert.throws(() => validateModulePatch({
    moduleId: 'media',
    values: { 'unknown.path': 1 },
    currentFile: {},
  }), /不包含参数/);

  const res = validateModulePatch({
    moduleId: 'reserved2',
    values: {
      'modes.reserved2.wait.minMs': 60000,
      'modes.reserved2.wait.maxMs': 10000,
    },
    currentFile: {},
  });
  assert.equal(res.nextFile.modes.reserved2.wait.minMs, 10000);
  assert.equal(res.nextFile.modes.reserved2.wait.maxMs, 60000);
});

test('applyHotModuleChanges 同步热更新运行态并触发对应模块钩子', () => {
  let reconciled = 0;
  let clearedSearch = 0;
  const b = {
    cfg: {
      dsh: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      allow: { groups: [], private: [] },
      deny: { groups: [], private: [] },
      ignore: { sendQQ: [] },
      webSearch: { provider: 'auto', timeoutMs: 35000 },
    },
    modelSelectionEpoch: 1,
    reconcileSessionPolicies: () => { reconciled += 1; },
    clearSearchCache: () => { clearedSearch += 1; },
  };
  const dshPatch = validateModulePatch({ moduleId: 'dsh', values: { 'dsh.model': 'deepseek-pro' }, currentFile: {} });
  applyHotModuleChanges(b, dshPatch);
  assert.equal(b.cfg.dsh.model, 'deepseek-pro');
  assert.equal(b.modelSelectionEpoch, 2);

  const gatePatch = validateModulePatch({ moduleId: 'gate', values: { 'allow.groups': ['123456'], 'ignore.sendQQ': ['99999'] }, currentFile: {} });
  applyHotModuleChanges(b, gatePatch);
  assert.deepEqual(b.cfg.allow.groups, ['123456']);
  assert.deepEqual(b.cfg.ignore.sendQQ, ['99999']);
  assert.equal(reconciled, 1);

  const searchPatch = validateModulePatch({ moduleId: 'search-pricing-security', values: { 'webSearch.timeoutMs': 20000 }, currentFile: {} });
  applyHotModuleChanges(b, searchPatch);
  assert.equal(b.cfg.webSearch.timeoutMs, 20000);
  assert.equal(clearedSearch, 1);
});

test('api-paths 允许 /assets/* 归属 web 命名空间且未知旧路径仍返回 removed', () => {
  assert.deepEqual(resolveApiPath('/assets/app.js'), { namespace: 'web', path: '/assets/app.js' });
  assert.deepEqual(resolveApiPath('/api/console/modules/reserved2'), { namespace: 'console', path: '/api/console/modules/reserved2' });
  assert.deepEqual(resolveApiPath('/legacy-status'), { namespace: 'removed', path: '/legacy-status' });
});
