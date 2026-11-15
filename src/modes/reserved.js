import { SILENT_MARKER } from '../policy/audit.js';

// 只描述模式策略；状态、调度和副作用由执行层持有。
export const reservedMode = Object.freeze({
  id: 'reserved', displayName: '一代仿真',
  capabilities: { schedule: ['probability', 'batched', 'timer'], memory: ['light', 'terms', 'long'], tools: 'restricted', send: 'timeline', context: 'window', exit: 'phase', permission: 'allowlist' },
  toolPolicy: { groups: ['read', 'memory', 'identity', 'web', 'send'], deny: ['sendBurst', 'sendPoke'], allowed: "preset" },
  memoryPolicy: { read: ['light', 'terms', 'long'], write: ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias'], maxChars: 1500 },
  sendPolicy: { mode: 'timeline', burst: true, audit: true },
  decide(evt, state) {
    if (!evt.flags.respond) return { action: 'drop', reason: 'respond-disabled' };
    if (state.phase === 'exiting' || evt.durationExit) return { action: 'defer', reason: 'exiting' };
    if (state.phase === 'active' || state.phase === 'probing') return { action: evt.kind === 'private' ? 'wake' : 'defer', strategy: 'batched', reason: 'active' };
    return { action: evt.direct || evt.random < evt.probability ? 'wake' : 'defer', strategy: evt.direct ? 'immediate' : 'probability', reason: evt.direct ? 'direct' : 'probability', priority: evt.direct ? 100 : 0 };
  },
  buildPrompt(ctx) {
    if (ctx.promptType === 'batch') {
      const direction = ctx.lines.includes('[引用') ? ctx.directionHint + '\n' : '';
      return `【新消息】\n${ctx.lines}\n\n${direction}${ctx.allowSilent ? `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。` : '请回复消息。'}\n${ctx.splitHint}`;
    }
    if (ctx.promptType === 'probe') return `【群聊上下文】\n${ctx.context}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${ctx.splitHint}`;
    if (ctx.promptType === 'exit') return `${ctx.roleHint ? ctx.roleHint + '\n\n' : ''}【群聊上下文】\n${ctx.context}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    if (ctx.promptType === 'proactive') return `${ctx.roleHint ? ctx.roleHint + '\n\n' : ''}【群聊上下文】\n${ctx.context}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${ctx.splitHint}`;
    const direction = ctx.text.includes('[引用') ? ctx.directionHint + '\n' : '';
    const instruction = ctx.direct
      ? `请回复消息。\n${direction}${ctx.splitHint}`
      : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${direction}${ctx.splitHint}`;
    return `${ctx.roleHint ? ctx.roleHint + '\n\n' : ''}【群聊上下文】\n${ctx.context}${ctx.roster ? `\n【群成员】\n${ctx.roster}` : ''}\n【当前消息】${ctx.line}${ctx.mediaHint}\n\n${instruction}`;
  },
  onTurnStart(ctx) { return ctx.activate ? { phase: 'active' } : null; },
  onTurnEnd(ctx, result) {
    return result.reason.kind === 'completed' && result.text.trim() ? { mode: 'timeline', text: result.text, farewell: ctx.farewell } : null;
  },
});
