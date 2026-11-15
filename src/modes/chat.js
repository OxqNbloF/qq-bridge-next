import { buildMessagePrompt } from '../conversations/mode-prompt.js';

// 只描述模式策略；状态、调度和副作用由执行层持有。
export const chatMode = Object.freeze({
  id: 'chat', displayName: '聊天',
  capabilities: { schedule: ['immediate'], memory: ['light', 'terms', 'long'], tools: 'restricted', send: 'auto-text', context: 'session', exit: 'none', permission: 'allowlist' },
  toolPolicy: { groups: ['read', 'memory', 'identity', 'web', 'ask', 'todo'], deny: [], allowed: "preset" },
  memoryPolicy: { read: ['light', 'terms', 'long'], write: ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias'], maxChars: 800 },
  sendPolicy: { mode: 'auto-text', burst: false, audit: true },
  decide(evt) {
    return { action: evt.flags.respond ? 'wake' : 'drop', strategy: 'immediate', reason: 'message', priority: 0 };
  },
  buildPrompt: buildMessagePrompt,
  onTurnStart() { return null; },
  onTurnEnd(ctx, result) {
    return result.reason.kind === 'completed' && result.text.trim() ? { mode: 'auto-text', text: result.text } : null;
  },
});
