import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  REDACTED_SECRET,
  ROOM_MODES,
  createSettingsStore,
  parseSettings,
  redactSettingsSecrets,
} from '../src/config/schema.js';
import { resolveControlSecret } from '../src/control/server.js';
import { createOneBotTransport } from '../src/gateway/transport.js';
import {
  isRoomPermitted,
  isSenderMuted,
  resolveRoomExecution,
  resolveRoomMode,
} from '../src/security/perimeter.js';

test('parseSettings validates modes and swaps inverted dormant bounds', () => {
  assert.deepEqual(ROOM_MODES, ['muted', 'observer', 'direct', 'ambient', 'operator']);
  const cfg = parseSettings({
    ownerId: 10001,
    pacing: { minDormantMs: 500000, maxDormantMs: 120000, dormantMs: 1000 },
  });
  assert.equal(cfg.ownerId, '10001');
  assert.equal(cfg.pacing.minDormantMs, 120000);
  assert.equal(cfg.pacing.maxDormantMs, 500000);
  assert.equal(cfg.pacing.dormantMs, 120000);
});

test('createSettingsStore preserves secrets when patched with REDACTED_SECRET', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  const store = createSettingsStore({
    configPath: cfgPath,
    initialConfig: { controlPlane: { secret: 'top-secret-alpha' }, transport: { token: 'ws-token-123' } },
  });

  const redacted = redactSettingsSecrets(store.get());
  assert.equal(redacted.controlPlane.secret, REDACTED_SECRET);
  assert.equal(redacted.controlPlane.hasSecret, true);

  store.patch({ controlPlane: { secret: REDACTED_SECRET, port: 3222 } });
  assert.equal(store.get().controlPlane.secret, 'top-secret-alpha');
  assert.equal(store.get().controlPlane.port, 3222);

  const info = resolveControlSecret({ dataDir: dir });
  assert.ok(info.secret.length >= 24);
  assert.equal(resolveControlSecret({ dataDir: dir }).secret, info.secret);
});

test('perimeter access control and per-room routing resolution', () => {
  const cfg = parseSettings({
    ownerId: '10001',
    perimeter: {
      allowedGroups: ['20001'],
      blockedGroups: ['20009'],
      mutedSenders: ['88888'],
      openWhenEmpty: false,
    },
    routing: {
      defaultGroupMode: 'ambient',
      defaultDirectMode: 'direct',
      rooms: {
        'group:20001': { mode: 'operator', engine: 'dsh', model: 'deepseek-pro' },
      },
    },
  });

  assert.equal(isRoomPermitted(cfg, 'group:20001'), true);
  assert.equal(isRoomPermitted(cfg, 'group:20002'), false);
  assert.equal(isRoomPermitted(cfg, 'group:20009'), false);
  assert.equal(isRoomPermitted(cfg, 'direct:10001'), true);
  assert.equal(isRoomPermitted(cfg, 'direct:99999'), false);
  assert.equal(isSenderMuted(cfg, '88888'), true);

  assert.equal(resolveRoomMode(cfg, 'group:20001'), 'operator');
  assert.equal(resolveRoomMode(cfg, 'group:20002'), 'ambient');
  const exec = resolveRoomExecution(cfg, 'group:20001');
  assert.equal(exec.engineId, 'dsh');
  assert.equal(exec.model, 'deepseek-pro');
  assert.equal(exec.scope, 'admin');
});

test('OneBot transport builds valid segment objects for text, reply, at, image, and audio', async () => {
  const sent = [];
  const transport = createOneBotTransport({
    getConfig: () => parseSettings({}),
    clientFactory: () => ({
      isConnected: true,
      sendGroupMessage: async (groupId, segs) => { sent.push({ kind: 'group', groupId, segs }); return {}; },
      sendPrivateMessage: async (userId, segs) => { sent.push({ kind: 'direct', userId, segs }); return {}; },
    }),
  });
  await transport.start();
  await transport.sendText('group:20001', '你好', { replyToMessageId: '77', mentionUserId: '10002' });
  await transport.sendImage('group:20001', 'https://example.com/a.png');
  await transport.sendAudio('direct:10001', '/tmp/demo.mp3');

  assert.equal(sent.length, 3);
  for (const call of sent) {
    assert.ok(Array.isArray(call.segs));
    for (const seg of call.segs) {
      assert.equal(typeof seg, 'object');
      assert.equal(typeof seg.type, 'string');
      assert.ok(seg.type.length > 0);
    }
  }
  assert.equal(sent[0].segs[0].type, 'reply');
  assert.equal(sent[0].segs[1].type, 'at');
  assert.equal(sent[1].segs[0].type, 'image');
  assert.equal(sent[2].segs[0].type, 'record');
  await transport.stop();
});
