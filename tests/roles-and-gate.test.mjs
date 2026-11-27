// 角色卡、开场说明、gateV2 成员四开关、撤回涂黑与拍一拍单测
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConfigStore } from '../src/config/schema.js';
import { createChatStore } from '../src/storage/chat-store.js';
import { createTurnQueue } from '../src/scheduler/turn-queue.js';
import { createHumanScheduler } from '../src/scheduler/human-wake.js';
import { createRoleStore } from '../src/features/roles.js';
import { createMemberGate } from '../src/security/member-gate.js';

test('角色卡 CRUD、防路径穿越、每 N 次注入节流与每聊开场说明', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-roles-'));
  try {
    const configStore = createConfigStore({ initialConfig: { persona: { injectEveryNWakes: 3, maxInjectChars: 500 } } });
    const roleStore = createRoleStore({ dataDir: dir, getConfig: () => configStore.get() });

    assert.throws(() => roleStore.saveRole('../evil', 'bad'), /非法/);
    roleStore.saveRole('傲娇助手', '你是一个略带傲娇但很热心的群友。');
    assert.equal(roleStore.listRoles().length, 1);
    roleStore.setActiveRole('傲娇助手');
    roleStore.setInitialPrompt('group:100', '先打个招呼');

    const w1 = roleStore.resolvePromptInjection('group:100');
    assert.equal(w1.full, true);
    assert.equal(w1.roleCardText.includes('傲娇'), true);
    assert.equal(w1.initialPrompt, '先打个招呼');

    const w2 = roleStore.resolvePromptInjection('group:100');
    assert.equal(w2.full, false);
    assert.equal(w2.roleCardText, '');

    const w3 = roleStore.resolvePromptInjection('group:100');
    assert.equal(w3.full, false);

    // 第 4 次唤醒达到 injectEveryNWakes=3 阈值，重新全量注入
    const w4 = roleStore.resolvePromptInjection('group:100');
    assert.equal(w4.full, true);
    assert.equal(w4.roleCardText.includes('傲娇'), true);

    assert.equal(roleStore.deleteRole('傲娇助手'), true);
    assert.equal(roleStore.getActiveRole().name, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateV2 成员四开关拦截 + 撤回保 seq 涂黑 + 拍一拍唤醒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-gate-'));
  const wakes = [];
  const configStore = createConfigStore({
    initialConfig: {
      ownerQQ: '1',
      gate: { enabled: true },
      access: { allowGroups: ['100'] },
      modes: { defaultGroup: 'human' },
      wake: { coalesceMs: 10, cooldownMs: 0, minUnreadBatch: 2 },
    },
  });
  const chatStore = createChatStore({ dataDir: dir });
  const memberGate = createMemberGate({ dataDir: dir, getConfig: () => configStore.get() });
  const turnQueue = createTurnQueue();
  const scheduler = createHumanScheduler({
    getConfig: () => configStore.get(),
    chatStore,
    turnQueue,
    memberGate,
    runChatTurn: async ({ convKey, reason }) => { wakes.push({ convKey, reason }); return { ok: true }; },
  });

  try {
    // 成员 222 设成只看上下文、不触发回应 (respond=false, converse=false)
    memberGate.setMemberFlags('100', '222', { respond: false, converse: false, context: true, memory: true });
    // 成员 333 设成连上下文都不进入 (context=false)
    memberGate.setMemberFlags('100', '333', { respond: false, converse: false, context: false, memory: false });

    const r222 = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '222', messageId: 'm222', text: '@bot 问你呢', atBot: true });
    assert.equal(r222.woken, false);
    assert.equal(r222.reason, 'gate_member_blocked');

    const r333 = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '333', messageId: 'm333', text: '隐藏消息' });
    assert.equal(r333.woken, false);

    // 模型可见未读应包含 m222（seq=1），绝不含 m333（context=false）
    const unreadModel = chatStore.getUnread('group:100', { forModel: true });
    assert.equal(unreadModel.messages.length, 1);
    assert.equal(unreadModel.messages[0].messageId, 'm222');

    // 撤回 m222：正文被替换为 [已撤回]，且保留原 seq 不出现空洞
    const prevSeq = unreadModel.messages[0].seq;
    assert.equal(scheduler.onRecall({ convKey: 'group:100', messageId: 'm222' }), true);
    const afterRecall = chatStore.getUnread('group:100', { forModel: true });
    assert.equal(afterRecall.messages[0].seq, prevSeq);
    assert.equal(afterRecall.messages[0].text, '[已撤回]');

    // 白名单模式测试：ownerQQ 依然放行，未列成员拦截
    memberGate.setGroupPolicy('100', { mode: 'whitelist' });
    assert.equal(memberGate.evaluate('group:100', '1').respond, true);
    assert.equal(memberGate.evaluate('group:100', '999').context, false);

    // 切回 all 模式验证拍一拍机器人在 respond=true 时唤醒
    memberGate.setGroupPolicy('100', { mode: 'all' });
    const pokeRes = scheduler.onPoke({ convKey: 'group:100', userId: '444', targetId: 'self', isTargetSelf: true });
    assert.equal(pokeRes.woken, true);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(wakes.some((w) => w.reason === 'poke'), true);
  } finally {
    scheduler.close();
    turnQueue.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
