import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayApp } from '../src/app.js';
import { resolveLibraryAudio } from '../src/features/audio.js';
import { createHubEngine } from '../src/hub/mcp-server.js';

test('audio resolver blocks traversal/unsupported files and hub executes emoticon + audio modules safely', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-media-'));
  const dataDir = path.join(rootDir, 'data');
  const audioDir = path.join(dataDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.from('ID3fake'));

  assert.throws(() => resolveLibraryAudio(audioDir, '../secret.mp3'));
  assert.throws(() => resolveLibraryAudio(audioDir, '/tmp/x.mp3'));
  assert.throws(() => resolveLibraryAudio(audioDir, 'bad.js'));
  assert.equal(resolveLibraryAudio(audioDir, 'hello.mp3'), path.join(audioDir, 'hello.mp3'));

  const sentImgs = [];
  const sentAudios = [];
  const app = createRelayApp({
    rootDir,
    dataDir,
    initialConfig: {
      controlPlane: { port: 0, secret: 'media-test-sec' },
      perimeter: { openWhenEmpty: true },
      audio: { enabled: true, libraryDir: 'data/audio', perMinuteCap: 1, perDayCap: 5 },
      toolbox: { enabledCapabilities: ['emoticon', 'audio'] },
    },
    transportClientFactory: () => ({
      isConnected: true,
      request: async (act) => (act === 'fetch_custom_face'
        ? { data: [{ id: 'emo-1', url: 'https://example.com/e1.png', remark: '哈哈' }] }
        : {}),
      sendGroupMessage: async (_gid, segs) => {
        if (segs[0]?.type === 'image') sentImgs.push(segs[0].data.file);
        if (segs[0]?.type === 'record') sentAudios.push(segs[0].data.file);
        return {};
      },
    }),
  });
  t.after(() => app.stop());
  await app.transport.start();

  const synced = await app.emoticonVault.syncFromTransport(app.transport);
  assert.equal(synced.added, 1);

  const { socketPath, scope } = await app.socketHub.ensureSocket('group:50001');
  const hub = createHubEngine({ socketPath, scope });

  const annoRes = await hub.invokeTool({ capability: 'emoticon', action: 'annotate', args: { id: 'emo-1', note: '敷衍用' } });
  assert.equal(annoRes.ok, true);
  const sendEmo = await hub.invokeTool({ capability: 'emoticon', action: 'send', args: { ref: 'emo-1' } });
  assert.equal(sendEmo.ok, true);
  assert.equal(sentImgs.length, 1);

  const audList = await hub.invokeTool({ capability: 'audio', action: 'list', args: {} });
  assert.equal(audList.files[0].name, 'hello.mp3');

  const aud1 = await hub.invokeTool({ capability: 'audio', action: 'send', args: { file: 'hello.mp3' } });
  assert.equal(aud1.ok, true);
  assert.equal(sentAudios.length, 1);

  // second send within same minute hits AUDIO_RATE_LIMITED
  const aud2 = await hub.invokeTool({ capability: 'audio', action: 'send', args: { file: 'hello.mp3' } });
  assert.equal(aud2.ok, false);
  assert.equal(aud2.code, 'AUDIO_RATE_LIMITED');
});
