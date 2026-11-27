import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayApp } from '../src/app.js';
import { createHubEngine } from '../src/hub/mcp-server.js';
import { buildSandboxArgs } from '../src/hub/runner.js';

function postUnixSocket(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      socketPath,
      path: '/hub/exec',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('hub executes real node modules over per-room unix socket and enforces live parent disable', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
  const sent = [];
  const app = createRelayApp({
    dataDir,
    initialConfig: {
      controlPlane: { port: 0, secret: 'e2e-secret-key' },
      perimeter: { openWhenEmpty: true },
      toolbox: { enabledCapabilities: ['chat', 'notes', 'pacing'] },
    },
    transportClientFactory: () => ({
      isConnected: true,
      sendGroupMessage: async (gid, segs) => { sent.push({ gid, segs }); return {}; },
    }),
  });
  t.after(() => app.stop());
  await app.transport.start();
  app.roomStore.recordInbound('group:30001', { messageId: 'm1', senderId: '10002', senderName: '阿哲', text: '大家好' });

  const { socketPath, scope } = await app.socketHub.ensureSocket('group:30001');
  const hub = createHubEngine({ socketPath, scope });

  // inspect_tools & invoke_tool against real modules/notes/run.mjs
  const listed = await hub.inspectTools();
  assert.deepEqual(listed.capabilities, ['chat', 'notes', 'pacing']);

  const putRes = await hub.invokeTool({ capability: 'notes', action: 'put', args: { content: '周五开黑' } });
  assert.equal(putRes.ok, true);
  const foundRes = await hub.invokeTool({ capability: 'notes', action: 'find', args: { query: '开黑' } });
  assert.equal(foundRes.items.length, 1);

  // say + finish against real modules/chat/run.mjs
  const sayRes = await hub.say({ messages: ['收到，准时到'] });
  assert.equal(sayRes.ok, true);
  assert.equal(sent.length, 1);
  const finRes = await hub.finish({ throughSeq: 1, pacing: { state: 'engaged', dormantMs: 120000 } });
  assert.equal(finRes.ok, true);
  assert.equal(finRes.readCursor, 1);

  // live revoke 'notes' from control panel
  app.settingsStore.patch({ toolbox: { enabledCapabilities: ['chat'] } });
  const deniedHub = await hub.invokeTool({ capability: 'notes', action: 'list', args: {} });
  assert.equal(deniedHub.ok, false);
  assert.equal(deniedHub.code, 'CAPABILITY_DISABLED');

  // even bypassing MCP straight to Unix socket hits CAPABILITY_DISABLED_BY_CONTROL
  const deniedSock = await postUnixSocket(socketPath, { capability: 'notes', action: 'list', args: {} });
  assert.equal(deniedSock.status, 403);
  assert.equal(deniedSock.body.code, 'CAPABILITY_DISABLED_BY_CONTROL');

  // undeclared arg rejected locally
  const badArgs = await hub.invokeTool({ capability: 'chat', action: 'unread', args: { hackParam: 1 } });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, 'INVALID_ARGS');

  const bwrap = buildSandboxArgs({ bin: 'node', binArgs: ['run.mjs'], modDir: '/m', repoRoot: '/r', socketPath, allowNetwork: false });
  assert.ok(bwrap.includes('--unshare-net'));
});
