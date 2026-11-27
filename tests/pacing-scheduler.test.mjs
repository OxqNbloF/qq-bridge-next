import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSettings } from '../src/config/schema.js';
import { createPacingScheduler } from '../src/scheduler/pacing.js';
import { createTurnQueue } from '../src/scheduler/turn-queue.js';
import { createRoomStore } from '../src/storage/room-store.js';

test('pacing scheduler differentiates ambient, observer, muted, and operator modes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pace-'));
  const roomStore = createRoomStore({ dataDir: dir });
  const turnQueue = createTurnQueue({ getMaxConcurrency: () => 2, getTurnTimeoutMs: () => 5000 });
  const triggered = [];

  const cfg = parseSettings({
    ownerId: '10001',
    perimeter: { openWhenEmpty: true },
    pacing: { coalesceMs: 15, cooldownMs: 0, batchThreshold: 3, triggerKeywords: ['暗号'] },
    routing: {
      defaultGroupMode: 'ambient',
      defaultDirectMode: 'direct',
      rooms: {
        'group:20002': { mode: 'observer' },
        'group:20003': { mode: 'muted' },
        'group:20004': { mode: 'operator' },
      },
    },
  });

  const pacing = createPacingScheduler({
    getConfig: () => cfg,
    roomStore,
    turnQueue,
    runRoomTurn: async ({ roomId, reason }) => {
      triggered.push({ roomId, reason });
      return { ok: true };
    },
  });

  // muted drops completely
  assert.equal(pacing.onInbound({ roomId: 'group:20003', senderId: '10002', text: '@bot' }).reason, 'mode_muted');
  // observer buffers without waking
  assert.equal(pacing.onInbound({ roomId: 'group:20002', senderId: '10002', text: '@bot' }).woken, false);
  // operator ignores non-owner, wakes owner
  assert.equal(pacing.onInbound({ roomId: 'group:20004', senderId: '10002', text: 'hi' }).woken, false);
  assert.equal(pacing.onInbound({ roomId: 'group:20004', senderId: '10001', text: 'status' }).reason, 'operator_owner');

  // ambient buffers casual chat, wakes on batchThreshold=3
  assert.equal(pacing.onInbound({ roomId: 'group:20001', senderId: '10002', text: '1' }).reason, 'buffered_ambient');
  assert.equal(pacing.onInbound({ roomId: 'group:20001', senderId: '10003', text: '2' }).reason, 'buffered_ambient');
  assert.equal(pacing.onInbound({ roomId: 'group:20001', senderId: '10004', text: '3' }).reason, 'ambient_batch');

  // keyword wakes immediately
  assert.equal(pacing.onInbound({ roomId: 'group:20005', senderId: '10002', text: '输入暗号吧' }).reason, 'keyword');

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(triggered.some((t) => t.roomId === 'group:20004'));
  assert.ok(triggered.some((t) => t.roomId === 'group:20001'));
  assert.ok(triggered.some((t) => t.roomId === 'group:20005'));
  assert.ok(!triggered.some((t) => t.roomId === 'group:20002'));

  // linger waits for message, recall redacts
  const waiter = pacing.waitForMessages('group:20001', { timeoutMs: 500, quietMs: 20 });
  pacing.onInbound({ roomId: 'group:20001', messageId: 'm99', senderId: '10002', text: 'secret slip' });
  const waited = await waiter;
  assert.equal(waited.messages.length, 1);

  assert.equal(pacing.onRecall({ roomId: 'group:20001', messageId: 'm99' }), true);
  assert.equal(roomStore.get('group:20001').recent.at(-1).text, '[已撤回]');

  pacing.close();
  turnQueue.cancelAll();
});
