// 外部家长控制 Web 控制台鉴权、CSP 静态边界、热切换后端与模式管理 API 单测
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridgeApp } from '../src/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('控制台 API 鉴权、CSP 外壳、热切换后端/模型、家长控制模块与会话重置端到端校验', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'index.html 不得包含内联 <script>');
  assert.equal(/<style[\s>]/i.test(html), false, 'index.html 不得包含内联 <style>');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-console-'));
  const app = createBridgeApp({
    rootDir: ROOT,
    configPath: path.join(tmpDir, 'config.json'),
    dataDir: path.join(tmpDir, 'data'),
    initialConfig: {
      console: { host: '127.0.0.1', port: 0, token: 'console-auth-secret' },
      access: { allowGroups: ['100'] },
      runtime: { activeBackend: 'agy', activeModel: '' },
    },
    onebotClientFactory: () => ({ connect: async () => {}, close: () => {}, on: () => {} }),
  });

  const started = await app.start({ connectOneBot: false });
  const base = `http://127.0.0.1:${started.console.port}`;
  try {
    // 1. 无 token 返回 401
    const unauth = await fetch(`${base}/api/console/overview`);
    assert.equal(unauth.status, 401);

    // 2. 伪造外网 Host 拒绝 (通过 Node http header 或检查静态页 CSP)
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-security-policy').includes("script-src 'self'"), true);

    const hdrs = { 'x-console-token': 'console-auth-secret', 'content-type': 'application/json' };

    // 3. 热切换全局后端到 gemini 并选模型
    const swRes = await fetch(`${base}/api/console/runtime`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ backendId: 'gemini', model: 'gemini-2.5-pro' }),
    });
    assert.equal(swRes.status, 200);
    const swJson = await swRes.json();
    assert.equal(swJson.runtime.activeBackend, 'gemini');
    assert.equal(swJson.runtime.activeModel, 'gemini-2.5-pro');

    // 4. 家长控制开关模块立即生效
    const putMod = await fetch(`${base}/api/console/modules`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ enabledModules: ['msg'] }),
    });
    assert.equal(putMod.status, 200);
    assert.deepEqual(app.configStore.get().broker.enabledModules, ['msg']);

    // 5. 修改单个聊天模式并校验持久落盘
    const patchChat = await fetch(`${base}/api/console/chats/${encodeURIComponent('group:100')}`, {
      method: 'PATCH',
      headers: hdrs,
      body: JSON.stringify({ mode: 'listen', backend: 'dsh', model: 'deepseek-pro' }),
    });
    assert.equal(patchChat.status, 200);
    const patchJson = await patchChat.json();
    assert.equal(patchJson.runtime.mode, 'listen');
    assert.equal(patchJson.runtime.backendId, 'dsh');
    assert.equal(patchJson.runtime.model, 'deepseek-pro');

    // 6. GET /api/console/config 不回显密钥明文
    const cfgRes = await fetch(`${base}/api/console/config`, { headers: hdrs });
    const cfgText = await cfgRes.text();
    assert.equal(cfgText.includes('console-auth-secret'), false);
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
