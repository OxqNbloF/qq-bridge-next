// Unix Socket 能力代理、家长控制实时禁用、零 Shell 模块脚本、MCP Broker 端到端链路回归
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridgeApp } from '../src/app.js';
import { createBrokerEngine, fetchSocketPolicy } from '../src/broker/mcp-server.js';
import { loadModuleManifests, parseModuleManifest } from '../src/broker/manifest.js';
import { buildBwrapArgs } from '../src/broker/runner.js';
import { applyBrokerSetup } from '../scripts/setup-broker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function unixReq(socketPath, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const raw = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      socketPath,
      path: reqPath,
      method,
      headers: raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, body: json });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

test('manifest/runner 安全校验 + Unix Socket 防伪造 + 端到端 MCP Broker -> modules/msg/run.mjs -> OneBot', async () => {
  const errors = [];
  const manifests = loadModuleManifests(path.join(ROOT, 'modules'), { onError: (n, e) => errors.push({ n, e }) });
  assert.deepEqual(errors, []);
  for (const name of ['msg', 'memory', 'wake', 'media', 'social', 'web']) {
    assert.equal(manifests.has(name), true);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-broker-'));
  const badMod = path.join(tmpDir, 'badmod');
  fs.mkdirSync(badMod, { recursive: true });
  fs.writeFileSync(path.join(badMod, 'manifest.json'), JSON.stringify({ name: 'bad', entry: '../escape.mjs', runtime: 'node' }));
  assert.throws(() => parseModuleManifest(badMod), /路径穿越/);

  const bwrapOffline = buildBwrapArgs({ bin: '/usr/bin/node', binArgs: ['run.mjs'], modDir: '/m', repoRoot: '/r', socketPath: '/s/a.sock', allowNetwork: false });
  assert.equal(bwrapOffline.includes('--unshare-net'), true);

  const sentToOneBot = [];
  const app = createBridgeApp({
    rootDir: ROOT,
    dataDir: path.join(tmpDir, 'data'),
    initialConfig: {
      console: { host: '127.0.0.1', port: 0, token: 'test-console-secret' },
      access: { allowGroups: ['456', '999'] },
      broker: { enabledModules: ['msg', 'memory'] },
    },
    onebotClientFactory: () => ({
      isConnected: true,
      connect: async () => {},
      close: () => {},
      onPrivateMessage: () => {},
      onGroupMessage: () => {},
      on: () => {},
      sendGroupMessage: async (groupId, segs) => {
        sentToOneBot.push({ groupId, segs });
        return { message_id: 'm1' };
      },
    }),
  });

  await app.start({ connectOneBot: true });
  try {
    const sock = await app.socketHub.ensureSocket('group:456');
    assert.equal(fs.existsSync(sock.socketPath), true);

    // 1. /broker/policy 不包含控制台密钥
    const pol = await unixReq(sock.socketPath, 'GET', '/broker/policy');
    assert.equal(pol.status, 200);
    assert.deepEqual(pol.body.enabledModules, ['msg', 'memory']);
    assert.equal(pol.text.includes('test-console-secret'), false);

    // 2. 控制台路径在 Unix Socket 上完全不存在 (404)
    const consoleRes = await unixReq(sock.socketPath, 'GET', '/api/console/config');
    assert.equal(consoleRes.status, 404);

    // 3. 伪造跨群 convKey=group:999 会被强制锁定为 group:456
    const spoof = await unixReq(sock.socketPath, 'POST', '/broker/action', {
      module: 'msg',
      action: 'read_unread',
      args: { convKey: 'group:999' },
    });
    assert.equal(spoof.status, 200);
    assert.equal(spoof.body.convKey, 'group:456');

    // 4. 真实子进程运行 modules/msg/run.mjs -> Socket -> outboundGuard -> OneBot
    const engine = createBrokerEngine({
      modulesDir: path.join(ROOT, 'modules'),
      socketPath: sock.socketPath,
      scope: 'chat',
      repoRoot: ROOT,
    });
    const sendOut = await engine.send({ messages: ['端到端测试消息'] });
    assert.equal(sendOut.ok, true);
    assert.equal(sentToOneBot.length, 1);
    assert.equal(sentToOneBot[0].groupId, 456);

    // 5. 控制台热关闭 msg 模块后立即 403 / MODULE_DISABLED
    app.configStore.patch({ broker: { enabledModules: ['memory'] } });
    const blocked = await engine.send({ messages: ['不该发出'] });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'MODULE_DISABLED');

    const directBlocked = await unixReq(sock.socketPath, 'POST', '/broker/action', {
      module: 'msg',
      action: 'read_unread',
      args: {},
    });
    assert.equal(directBlocked.status, 403);
    assert.equal(directBlocked.body.code, 'MODULE_DISABLED_BY_PARENT');

    // 6. 吊销 Socket 后无法连接
    assert.equal(app.socketHub.revokeSocket('group:456'), true);
    await assert.rejects(() => fetchSocketPolicy(sock.socketPath));

    // 7. setup-broker 干跑与合并写入
    const geminiHome = path.join(tmpDir, 'gemini-home');
    const dry = applyBrokerSetup({ rootDir: ROOT, geminiHome, target: 'all', dryRun: true });
    assert.equal(dry.files.length, 3);
    assert.equal(fs.existsSync(path.join(geminiHome, 'settings.json')), false);
    applyBrokerSetup({ rootDir: ROOT, geminiHome, target: 'all', dryRun: false });
    const gemSettings = JSON.parse(fs.readFileSync(path.join(geminiHome, 'settings.json'), 'utf8'));
    assert.equal(Boolean(gemSettings.mcpServers['qq-broker']), true);
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
