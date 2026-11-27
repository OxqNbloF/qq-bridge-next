// 表情库与语音库模块、家长控制裁剪与新建控制台 REST API 回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridgeApp } from '../src/app.js';
import { createBrokerEngine } from '../src/broker/mcp-server.js';
import { safeJoinLibrary } from '../src/features/voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('sticker & voice 经 Unix Socket 端到端受控调用 + 家长控制 + 控制台全能力 API 校验', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-media-broker-'));
  const voiceDir = path.join(tmpDir, 'voices');
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.writeFileSync(path.join(voiceDir, 'hello.mp3'), Buffer.from('ID3mockaudio'));
  fs.writeFileSync(path.join(voiceDir, 'evil.txt'), 'not audio');

  assert.throws(() => safeJoinLibrary(voiceDir, '../etc/passwd'), /路径穿越/);
  assert.throws(() => safeJoinLibrary(voiceDir, '/abs/hello.mp3'), /禁止绝对路径/);
  assert.throws(() => safeJoinLibrary(voiceDir, 'evil.txt'), /扩展名/);

  const sentImages = [];
  const sentRecords = [];

  const app = createBridgeApp({
    rootDir: ROOT,
    configPath: path.join(tmpDir, 'config.json'),
    dataDir: path.join(tmpDir, 'data'),
    initialConfig: {
      console: { host: '127.0.0.1', port: 0, token: 'media-console-tok' },
      access: { allowGroups: ['100'] },
      voice: { enabled: true, dir: voiceDir, maxPerMinute: 2, maxPerDay: 5 },
      broker: { enabledModules: ['msg', 'sticker', 'voice', 'media', 'memory'] },
    },
    onebotClientFactory: () => ({
      isConnected: true,
      connect: async () => {},
      close: () => {},
      on: () => {},
      request: async (action, params) => {
        if (action === 'fetch_custom_face') {
          return { data: [{ id: 'stk1', url: 'https://example.com/stk1.png', remark: '猫猫' }] };
        }
        if (action === 'get_forward_msg') {
          return { data: [{ data: { name: '友', content: '转发测试' } }] };
        }
        return {};
      },
      sendGroupMessage: async (gid, segs) => {
        if (segs.some((s) => s.type === 'image')) sentImages.push({ gid, segs });
        if (segs.some((s) => s.type === 'record')) sentRecords.push({ gid, segs });
        return { message_id: 'ok' };
      },
    }),
  });

  const started = await app.start({ connectOneBot: true });
  const base = `http://127.0.0.1:${started.console.port}`;
  const hdrs = { 'x-console-token': 'media-console-tok', 'content-type': 'application/json' };

  try {
    // 1. 控制台同步表情、写黑话、写角色卡与 gateV2 成员策略
    const syncRes = await fetch(`${base}/api/console/stickers/sync`, { method: 'POST', headers: hdrs });
    const syncJson = await syncRes.json();
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.count, 1);

    await fetch(`${base}/api/console/roles/%E6%B5%8B%E8%AF%95%E8%A7%92%E8%89%B2`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ content: '测试角色正文' }),
    });
    const rolesRes = await (await fetch(`${base}/api/console/roles`, { headers: hdrs })).json();
    assert.equal(rolesRes.roles.length, 1);

    const gateRes = await fetch(`${base}/api/console/gate/members/100/888`, {
      method: 'PATCH',
      headers: hdrs,
      body: JSON.stringify({ respond: false, converse: false, context: true, memory: true }),
    });
    assert.equal(gateRes.status, 200);

    const sock = await app.socketHub.ensureSocket('group:100');
    const engine = createBrokerEngine({
      modulesDir: path.join(ROOT, 'modules'),
      socketPath: sock.socketPath,
      scope: 'chat',
      repoRoot: ROOT,
    });

    // 2. 通过 Broker 子进程发送收藏表情与语音
    const stkOut = await engine.call({ module: 'sticker', action: 'send', args: { ref: 'stk1' } });
    assert.equal(stkOut.ok, true);
    assert.equal(sentImages.length, 1);

    const voiceList = await engine.call({ module: 'voice', action: 'list', args: {} });
    assert.equal(voiceList.ok, true);
    assert.equal(voiceList.voices.length, 1);

    const voiceOut = await engine.call({ module: 'voice', action: 'send', args: { file: 'hello.mp3' } });
    assert.equal(voiceOut.ok, true);
    assert.equal(sentRecords.length, 1);

    // 路径穿越被拒绝
    const badVoice = await engine.call({ module: 'voice', action: 'send', args: { file: '../secret.mp3' } });
    assert.equal(badVoice.ok, false);

    // 合并转发展开
    const fwdOut = await engine.call({ module: 'media', action: 'get_forward', args: { forwardId: 'f1' } });
    assert.equal(fwdOut.ok, true);
    assert.equal(fwdOut.lines[0].includes('转发测试'), true);

    // 3. 家长控制动态禁用 voice 后立刻禁止发送
    await fetch(`${base}/api/console/modules`, {
      method: 'PUT',
      headers: hdrs,
      body: JSON.stringify({ enabledModules: ['msg', 'sticker'] }),
    });
    const blockedVoice = await engine.call({ module: 'voice', action: 'send', args: { file: 'hello.mp3' } });
    assert.equal(blockedVoice.ok, false);
    assert.equal(blockedVoice.code, 'MODULE_DISABLED');
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
