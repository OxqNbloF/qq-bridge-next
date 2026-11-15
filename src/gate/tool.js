import { canonicalV2Key } from '../policy/access.js';
import { toolSources } from '../policy/send-guard.js';
import { modelMessageVisible } from './model-visibility.js';

// 第三列是成员语义，不是能力组的隐式四开关：
// session: 会话级状态/配置/机器人资源，不借任一群成员授权。
// content: 返回内容按实际作者逐项 context 过滤（路由负责，不能要求触发者 respond）。
// roster: 身份目录按目标成员 context 过滤，不把目标当来源。
// memoryRead: 既有记忆查询；群内没有新来源授权，私聊维持 memory 开关。
// derive: 模型派生持久化（包括表情备注），所有已知来源须 context+memory。
// respond: 对外回应；所有已知来源须 context+converse+respond，缺来源拒绝。
// admin/web/ask/todo 没有此 HTTP 网关公开回调，未知路由默认拒绝。
export const TOOL_ROUTES = Object.freeze({
  'GET /api/agent/status': ['read', undefined, 'session'],
  ...Object.fromEntries(Object.entries({
    prompt: ['read', 'getPrompt', 'content'], unread: ['read', 'getUnread', 'content'], recent: ['read', 'getRecent', 'content'],
    state: ['read', 'socialState', 'session'], 'my-recent': ['read', 'getMyRecent', 'content'], 'message-detail': ['read', 'getMessageDetail', 'content'],
    'forward-message': ['read', 'getForwardMsg', 'content'], 'active-members': ['identity', 'getActiveMembers', 'content'], 'group-members': ['identity', 'getGroupMembers', 'roster'],
    memory: ['memory', 'memory', 'memoryRead'],
    'sticker-list': ['sticker', 'listStickers', 'session'], 'sticker-image': ['sticker', 'getStickerImage', 'session'],
    'self-image': ['identity', 'getSelfImage', 'session'], voices: ['voice', 'sendVoice', 'session'],
  }).map(([path, rule]) => [`GET /api/agent/${path}`, rule])),
  ...Object.fromEntries(Object.entries({
    'mark-read': ['turn', 'markRead', 'session'], 'wake-config': ['turn', 'setWakeConfig', 'session'], wait: ['turn', 'waitMessages', 'content'],
    feedback: ['read', 'feedback', 'session'], 'forward-media': ['read', 'getForwardMsg', 'content'],
    'memory-append': ['memory', 'memory', 'derive'], 'memory-update': ['memory', 'memory', 'derive'],
    'memory-remove': ['memory', 'memory', 'session'], 'memory-clear': ['memory', 'memory', 'session'],
    'send-message': ['send', 'sendMessage', 'respond'], 'send-burst': ['send', 'sendBurst', 'respond'],
    'send-poke': ['send', 'sendPoke', 'respond'], 'send-sticker': ['sticker', 'sendSticker', 'respond'],
    'sticker-note': ['sticker', 'stickerNote', 'derive'], 'sticker-remark': ['sticker', 'setStickerRemark', 'derive'],
    'collect-sticker': ['sticker', 'collectSticker', 'derive'], 'send-voice': ['voice', 'sendVoice', 'respond'],
    'sticker-list': ['sticker', 'listStickers', 'session'], 'check-send': ['send', undefined, 'respond'],
  }).map(([path, rule]) => [`POST /api/agent/${path}`, rule])),
  'POST /api/agent/send/group': ['send', 'sendGroup', 'respond'], 'POST /api/agent/send/private': ['send', 'sendPrivate', 'respond'],
  'POST /api/agent/send/reply': ['send', 'reply', 'respond'], 'GET /api/agent/images/message': ['read', 'getImages', 'content'],
  'POST /api/agent/authorize/read': ['read', undefined, 'session'],
});

export function projectToolMemberResult(b, key, rule, value) {
  if (!b.cfg.architecture?.gateV2 || rule?.[2] !== 'roster' || !Array.isArray(value?.members)) return value;
  const members = value.members.filter(member => modelMessageVisible(b, key, member));
  // 不通过 count 泄露隐藏目录大小；路由已分页，只报告本页可见人数。
  return { ...value, members, count: members.length, returned: members.length, truncated: value.truncated === true };
}

export function captureToolMemberGuard(b, key, rule) {
  const sources = b.cfg.architecture?.gateV2 ? toolSources(b, key) : undefined;
  return () => assertToolMemberAllowed(b, key, rule, sources);
}

export function assertToolMemberAllowed(b, key, rule, originalSources) {
  if (!b.cfg.architecture?.gateV2) return;
  key = canonicalV2Key(key);
  const deny = reason => { throw Object.assign(new Error(`成员策略不允许该工具（${reason}）`), { statusCode: 403 }); };
  if (!key || !rule) return deny('unknown-tool-session');
  const [kind, id] = key.split(':');
  const semantic = rule[2];
  const flags = semantic === 'respond' ? ['context', 'converse', 'respond'] : semantic === 'derive' ? ['context', 'memory'] : [];
  // 私聊的对端身份由会话明确给出；保留原私聊记忆工具限制，不外溢普通 read。
  if (kind === 'private') {
    if (rule[0] === 'memory' && !flags.includes('memory')) flags.push('memory');
    const gate = b.gateDecide({ kind, id: Number(id), qq: id });
    if (!gate.allowed || flags.some(flag => gate.flags[flag] !== true)) deny(gate.reason || flags.join('+'));
    return;
  }
  if (!flags.length) return; // 会话工具和逐项过滤读取，不需要“任意来源成员”。
  const current = toolSources(b, key);
  const actors = new Set([...current.actors, ...(originalSources?.actors ?? [])]);
  const incomplete = current.incomplete || originalSources?.incomplete;
  if (incomplete || !actors.size) return deny(incomplete ? 'model-sources-incomplete' : 'source-unknown');
  for (const qq of actors) {
    const gate = b.gateDecide({ kind, id: Number(id), qq });
    if (!gate.allowed || flags.some(flag => gate.flags[flag] !== true)) deny(gate.reason || flags.join('+'));
  }
}
