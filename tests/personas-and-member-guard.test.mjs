import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSettings } from '../src/config/schema.js';
import { createPersonaVault, normalizePersonaName } from '../src/features/personas.js';
import { createPacingScheduler } from '../src/scheduler/pacing.js';
import { createTurnQueue } from '../src/scheduler/turn-queue.js';
import { createMemberGuard } from '../src/security/member-guard.js';
import { createRoomStore } from '../src/storage/room-store.js';

test('persona vault rejects traversal, injects cards per refresh interval, and stores room intros', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-role-'));
  assert.throws(() => normalizePersonaName('../bad'));
  assert.throws(() => normalizePersonaName('a/b'));

  const cfg = parseSettings({ character: { refreshEveryNWakes: 2, maxCardChars: 2000 } });
  const vault = createPersonaVault({ dataDir: dir, getConfig: () => cfg });
  vault.savePersona('猫娘', '你是一个爱吐槽的群友。');
  vault.setActivePersona('猫娘');
  vault.setRoomIntro('group:20001', '只讨论游戏');

  const r1 = vault.resolvePromptCard('group:20001');
  const r2 = vault.resolvePromptCard('group:20001');
  const r3 = vault.resolvePromptCard('group:20001');
  assert.equal(r1.full, true);
  assert.equal(r2.full, false);
  assert.equal(r3.full, true);
  assert.equal(r1.intro, '只讨论游戏');
});

test('member guard enforces open / deny_listed / allow_listed 4-switch policies and owner exemption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mem-'));
  const cfg = parseSettings({ ownerId: '10001', memberPolicy: { enabled: true }, perimeter: { openWhenEmpty: true } });
  const guard = createMemberGuard({ dataDir: dir, getConfig: () => cfg });

  guard.setGroupRule('20001', { mode: 'allow_listed' });
  guard.setMemberCapabilities('20001', '10002', { canTrigger: false, canEngage: false, inContext: true, inMemory: false });

  // owner bypass
  assert.equal(guard.evaluateMember('group:20001', '10001').canTrigger, true);
  // unlisted in allow_listed blocked everywhere
  assert.equal(guard.evaluateMember('group:20001', '10099').inContext, false);
  // listed member honors granular 4 switches
  const caps = guard.evaluateMember('group:20001', '10002');
  assert.equal(caps.canTrigger, false);
  assert.equal(caps.inContext, true);
  assert.equal(caps.inMemory, false);

  // scheduler hides !inContext from model view
  const roomStore = createRoomStore({ dataDir: dir });
  const turnQueue = createTurnQueue();
  const pacing = createPacingScheduler({
    getConfig: () => cfg,
    roomStore,
    turnQueue,
    memberGuard: guard,
    runRoomTurn: async () => ({ ok: true }),
  });

  const dropped = pacing.onInbound({ roomId: 'group:20001', senderId: '10099', text: '看不到我' });
  assert.equal(dropped.reason, 'member_trigger_blocked');
  assert.equal(roomStore.readUnread('group:20001', { modelOnly: true }).messages.length, 0);

  const quiet = pacing.onInbound({ roomId: 'group:20001', senderId: '10002', text: '看得到但不能触发' });
  assert.equal(quiet.reason, 'member_trigger_blocked');
  assert.equal(roomStore.readUnread('group:20001', { modelOnly: true }).messages.length, 1);

  pacing.close();
  turnQueue.cancelAll();
});
