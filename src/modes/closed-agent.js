import { buildMessagePrompt } from '../conversations/mode-prompt.js';

// 只描述模式策略；状态、调度和副作用由执行层持有。
export const closedAgentMode = Object.freeze({
  id: 'closed-agent', displayName: '管理员代理',
  capabilities: { schedule: ['immediate'], memory: ['light', 'terms', 'long'], tools: 'full', send: 'auto-text', context: 'session', exit: 'none', permission: 'owner-private' },
  toolPolicy: { groups: ['turn', 'read', 'memory', 'identity', 'web', 'ask', 'todo', 'send', 'sticker', 'voice', 'admin'], deny: [], allowed: "full" },
  memoryPolicy: { read: ['light', 'terms', 'long'], write: ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias'], maxChars: 800 },
  sendPolicy: { mode: 'auto-text', burst: false, audit: false },
  decide(evt) {
    return { action: evt.flags.respond ? 'wake' : 'drop', strategy: 'immediate', reason: 'message', priority: 0 };
  },
  buildPrompt: buildMessagePrompt,
  onTurnStart() { return null; },
  onTurnEnd(ctx, result) {
    return result.reason.kind === 'completed' && result.text.trim() ? { mode: 'auto-text', text: result.text } : null;
  },
});
