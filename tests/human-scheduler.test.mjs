// 拟人群聊低频唤醒调度器、分聊天模式与 waitForNewMessages 单测
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfigStore } from '../src/config/schema.js';
import { createChatStore } from '../src/storage/chat-store.js';
import { createTurnQueue } from '../src/scheduler/turn-queue.js';
import { createHumanScheduler } from '../src/scheduler/human-wake.js';

test('human 模式对普通群闲聊保持静默缓冲，达阈值才唤醒；listen 模式永不唤醒；@bot 快速唤醒', async () => {
  const wakes = [];
  const configStore = createConfigStore({
    initialConfig: {
      access: { allowGroups: ['100', '200'], allowPrivate: ['500'] },
      modes: {
        defaultGroup: 'human',
        chats: { 'group:200': { mode: 'listen' } },
      },
      wake: { coalesceMs: 10, cooldownMs: 0, minUnreadBatch: 3, minSleepMs: 1000, maxSleepMs: 60000, defaultSleepMs: 50000 },
    },
  });
  const chatStore = createChatStore();
  const turnQueue = createTurnQueue();
  const scheduler = createHumanScheduler({
    getConfig: () => configStore.get(),
    chatStore,
    turnQueue,
    runChatTurn: async ({ convKey, reason }) => {
      wakes.push({ convKey, reason });
      return { ok: true };
    },
  });

  try {
    // 1. listen 群只存档，不唤醒
    const l1 = scheduler.onIncomingMessage({ convKey: 'group:200', userId: '1', text: 'hello', atBot: true });
    assert.equal(l1.accepted, true);
    assert.equal(l1.woken, false);
    assert.equal(chatStore.get('group:200').unread.length, 1);

    // 2. human 群前两条普通闲聊只本地累计，不惊动 Agent
    const h1 = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '1', text: '大家好' });
    const h2 = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '2', text: '在干嘛' });
    assert.equal(h1.woken, false);
    assert.equal(h2.woken, false);

    // 第 3 条达到 minUnreadBatch=3，触发 ambient_batch 唤醒
    const h3 = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '3', text: '今天天气不错' });
    assert.equal(h3.woken, true);
    assert.equal(h3.reason, 'ambient_batch');

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(wakes.some((w) => w.convKey === 'group:100' && w.reason === 'ambient_batch'), true);

    // 3. @机器人立刻唤醒
    const atRes = scheduler.onIncomingMessage({ convKey: 'group:100', userId: '1', text: '@bot 帮我看下', atBot: true });
    assert.equal(atRes.woken, true);
    assert.equal(atRes.reason, 'mention');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(wakes.some((w) => w.reason === 'mention'), true);

    // 4. applyWakeConfig 将 sleepMs 钳制在控制台允许区间内
    const clamped = scheduler.applyWakeConfig('group:100', { mode: 'sleep', sleepMs: 100 });
    assert.equal(clamped.sleepMs, 1000);

    // 5. waitForNewMessages 能捕获后续新消息
    const waitPromise = scheduler.waitForNewMessages('group:100', { timeoutMs: 2000 });
    scheduler.onIncomingMessage({ convKey: 'group:100', userId: '9', text: '补充一句' });
    const waitResult = await waitPromise;
    assert.equal(waitResult.messages.length, 1);
    assert.equal(waitResult.messages[0].text, '补充一句');
  } finally {
    scheduler.close();
    turnQueue.close();
  }
});
