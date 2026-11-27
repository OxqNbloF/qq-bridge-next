import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayApp } from '../src/app.js';
import { REDACTED_SECRET } from '../src/config/schema.js';

async function reqJson(port, route, { method = 'GET', secret = '', body } = {}) {
  const headers = {};
  if (secret) headers['x-control-secret'] = secret;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

test('control plane requires x-control-secret, hot-switches engines/capabilities/rooms, and serves CSP UI', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ctrl-'));
  const app = createRelayApp({
    dataDir,
    initialConfig: {
      controlPlane: { host: '127.0.0.1', port: 0, secret: 'ctrl-secret-test' },
      transport: { token: 'onebot-token-abc' },
      perimeter: { openWhenEmpty: true },
    },
    transportClientFactory: () => ({ isConnected: true }),
    dshClientFactory: () => ({ resolveBase: () => 'http://127.0.0.1:3080' }),
  });
  t.after(() => app.stop());

  const { control } = await app.start({ startTransport: false });
  const secret = 'ctrl-secret-test';

  // unauth blocked
  const unauth = await reqJson(control.port, '/api/control/overview');
  assert.equal(unauth.status, 401);

  // overview redacts secrets
  const ov = await reqJson(control.port, '/api/control/overview', { secret });
  assert.equal(ov.status, 200);
  assert.equal(ov.json.settings.controlPlane.secret, REDACTED_SECRET);
  assert.equal(ov.json.settings.transport.token, REDACTED_SECRET);

  // switch active engine
  const sw = await reqJson(control.port, '/api/control/active-engine', {
    method: 'PUT',
    secret,
    body: { engineId: 'dsh', model: 'deepseek-pro' },
  });
  assert.equal(sw.status, 200);
  assert.equal(sw.json.activeEngine.active, 'dsh');
  assert.equal(sw.json.activeEngine.model, 'deepseek-pro');

  // update capabilities live
  const capPut = await reqJson(control.port, '/api/control/capabilities', {
    method: 'PUT',
    secret,
    body: { enabledCapabilities: ['chat', 'pacing'] },
  });
  assert.deepEqual(capPut.json.enabledCapabilities, ['chat', 'pacing']);

  // patch room mode + set room intro
  const roomPatch = await reqJson(control.port, `/api/control/rooms/${encodeURIComponent('group:40001')}`, {
    method: 'PATCH',
    secret,
    body: { mode: 'observer', paused: false },
  });
  assert.equal(roomPatch.status, 200);
  assert.equal(roomPatch.json.room.mode, 'observer');

  const introPut = await reqJson(control.port, `/api/control/rooms/${encodeURIComponent('group:40001')}/intro`, {
    method: 'PUT',
    secret,
    body: { intro: '这是一个技术闲聊群' },
  });
  assert.equal(introPut.json.intro, '这是一个技术闲聊群');

  // web static + CSP
  const htmlRes = await fetch(`http://127.0.0.1:${control.port}/`);
  assert.equal(htmlRes.status, 200);
  assert.ok(htmlRes.headers.get('content-security-policy').includes("script-src 'self'"));
});
