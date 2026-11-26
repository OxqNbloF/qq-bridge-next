// 配置校验、密钥脱敏、热更新与访问控制/会话模式单测
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConfigStore, maskConfigSecrets, parseConfig, SECRET_MASK } from '../src/config/schema.js';
import { canonicalConvKey, isChatAllowed, resolveChatMode, resolveChatRuntime } from '../src/security/access.js';

test('parseConfig 校验默认值、自定义 CLI 配置与 sleepMs 边界归一化', () => {
  const cfg = parseConfig({
    runtime: { activeBackend: 'claude', activeModel: 'sonnet' },
    wake: { minSleepMs: 120000, maxSleepMs: 60000, defaultSleepMs: 5000 },
    backends: {
      cliProfiles: {
        claude: {
          label: 'Claude Code',
          command: 'claude',
          argsTemplate: ['-p', '{{prompt}}'],
        },
      },
    },
  });
  assert.equal(cfg.runtime.activeBackend, 'claude');
  assert.equal(cfg.runtime.activeModel, 'sonnet');
  assert.equal(cfg.wake.minSleepMs, 60000);
  assert.equal(cfg.wake.maxSleepMs, 120000);
  assert.equal(cfg.wake.defaultSleepMs, 60000);

  assert.throws(() => parseConfig({ runtime: { activeBackend: 'nonexistent' } }), /未知 activeBackend/);
});

test('createConfigStore 支持热补丁并保留脱敏占位符对应的真实密钥', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-cfg-'));
  const file = path.join(dir, 'config.json');
  try {
    const store = createConfigStore({
      configPath: file,
      initialConfig: {
        console: { token: 'real-console-token-xyz' },
        onebot: { accessToken: 'real-ob-token-xyz' },
      },
    });
    const masked = maskConfigSecrets(store.get());
    assert.equal(masked.console.token, SECRET_MASK);
    assert.equal(masked.console.hasToken, true);

    store.patch({
      console: { token: SECRET_MASK, port: 3200 },
      runtime: { activeBackend: 'gemini', activeModel: 'gemini-2.5-pro' },
    });
    assert.equal(store.get().console.token, 'real-console-token-xyz');
    assert.equal(store.get().console.port, 3200);
    assert.equal(store.get().runtime.activeBackend, 'gemini');
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('access 控制白/黑名单、ownerQQ 特权与单聊覆盖模式/后端/模型', () => {
  const cfg = parseConfig({
    ownerQQ: '10001',
    access: {
      allowGroups: ['20002', '30003'],
      denyGroups: ['30003'],
      allowPrivate: ['40004'],
      denyPrivate: ['50005'],
    },
    modes: {
      defaultGroup: 'human',
      defaultPrivate: 'chat',
      chats: {
        'group:20002': { mode: 'listen', backend: 'gemini', model: 'gemini-2.5-pro' },
      },
    },
    runtime: { activeBackend: 'agy', activeModel: 'agy-fast' },
  });

  assert.equal(canonicalConvKey('group:20002'), 'group:20002');
  assert.equal(canonicalConvKey('bad:key'), null);
  assert.equal(isChatAllowed(cfg, 'group:20002'), true);
  assert.equal(isChatAllowed(cfg, 'group:30003'), false);
  assert.equal(isChatAllowed(cfg, 'private:10001'), true);
  assert.equal(isChatAllowed(cfg, 'private:40004'), true);
  assert.equal(isChatAllowed(cfg, 'private:99999'), false);

  assert.equal(resolveChatMode(cfg, 'group:20002'), 'listen');
  assert.equal(resolveChatMode(cfg, 'private:40004'), 'chat');

  const groupRt = resolveChatRuntime(cfg, 'group:20002');
  assert.equal(groupRt.backendId, 'gemini');
  assert.equal(groupRt.model, 'gemini-2.5-pro');
  assert.equal(groupRt.mode, 'listen');

  const privRt = resolveChatRuntime(cfg, 'private:40004');
  assert.equal(privRt.backendId, 'agy');
  assert.equal(privRt.model, 'agy-fast');
});
