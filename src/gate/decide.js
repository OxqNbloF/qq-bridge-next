// 门禁纯函数：四开关归一化 + 统一判定（docs/architecture-refactor.md §5.4）
// 只读输入、无 IO；尚未接入运行时（步骤 2.1）
import { allowed, ignoredSender } from '../policy/access.js';

export const FLAG_KEYS = Object.freeze(['respond', 'converse', 'context', 'memory']);
export const DEFAULT_FLAGS = Object.freeze({ respond: true, converse: true, context: true, memory: true });
export const MEMBER_MODES = Object.freeze(['all', 'blacklist', 'whitelist']);

const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** 四开关归一化：缺省取默认，写了但不是 true 一律当 false；非法组合取保守值 */
export function normalizeFlags(flags, defaults = DEFAULT_FLAGS) {
  const out = {};
  for (const k of FLAG_KEYS) out[k] = own(flags, k) !== undefined ? flags[k] === true : defaults[k] !== false;
  if (!out.converse) out.respond = false; // respond ⇒ converse
  if (!out.converse && !out.memory) out.context = false; // 没有渲染载体
  return out;
}

/**
 * 会话层判定（模式 + 会话白名单），入口/发送/工具/HTTP 共用这一处
 * @param {boolean} closedAgentOk 该会话是否是 closed-agent 的 owner 私聊（由 session-router 判定，调用方传入）
 * @param {boolean} listed closed-agent 下也要求在会话白名单内（发送与 HTTP 侧的双重确认）
 * @returns {string|null} 拒绝原因（mode-denied / conv-denied）或 null
 */
export function conversationGate({ kind, id, cfg, mode, closedAgentOk, listed = false }) {
  if (mode === 'closed-agent') {
    if (!closedAgentOk) return 'mode-denied';
    return listed && !allowed(kind, id, cfg) ? 'conv-denied' : null;
  }
  return allowed(kind, id, cfg) ? null : 'conv-denied';
}

/**
 * 统一判定：runtime → conversation/mode → member
 * @param {object} i kind/id 会话；qq 发送者；cfg 配置；mode 该会话所在模式；
 *   runtime {silent, paused, aiReply}；policy 成员策略文档；policyBroken 策略文件损坏
 * @returns {{allowed: boolean, reason: string, flags: object, gate: object}}
 */
export function decide({ kind, id, qq, cfg, mode, runtime = {}, policy = null, policyBroken = false, defaultFlags = DEFAULT_FLAGS, applyMemberPolicy = true, closedAgentOk }) {
  const gate = { memberMode: 'all' };
  const deny = (reason) => ({ allowed: false, reason, flags: normalizeFlags({ respond: false, converse: false, context: false, memory: false }), gate });
  const allow = (flags, reason = 'ok') => ({ allowed: true, reason, flags, gate });
  const base = () => normalizeFlags(null, defaultFlags);

  const sender = String(qq ?? '');
  if (!/^[1-9]\d*$/.test(sender)) return deny('bad-sender');
  const isOwner = sender === String(cfg.ownerQQ ?? '');

  if (runtime.silent && !isOwner) return deny('silent');
  if (runtime.paused && runtime.aiReply) return deny('paused');

  // 复用 conversationGate：closed-agent 只认 owner 私聊且不查白名单，其余模式查白名单
  const convDenied = conversationGate({ kind, id, cfg, mode, closedAgentOk: closedAgentOk ?? (kind === 'private' && isOwner && String(id) === sender) });
  if (convDenied) return deny(convDenied);

  if (applyMemberPolicy && policyBroken) {
    // 策略文件损坏 fail-closed：不回应/不入对话上下文/对模型不可见，但保留原始消息归档；管理员仅保留命令入口
    if (isOwner) return allow({ respond: true, converse: true, context: false, memory: true }, 'policy-broken');
    return allow({ respond: false, converse: false, context: false, memory: true }, 'policy-broken');
  }

  if (isOwner) {
    // 管理命令/审批入口不受名单限制，但隐私开关不因管理员身份被抹掉。
    const globalFlags = own(policy?.global, sender)?.flags;
    const memberFlags = kind === 'private' ? own(policy?.private, sender)
      : own(own(policy?.groups, `group:${id}`)?.rules, sender)?.flags;
    const privacy = applyMemberPolicy ? normalizeFlags(memberFlags ?? globalFlags, defaultFlags) : base();
    return allow({ ...base(), context: privacy.context, memory: privacy.memory });
  }
  if (ignoredSender(sender, cfg)) return deny('ignored'); // 旧 ignore.sendQQ 兼容层
  if (!applyMemberPolicy) return allow(base());
  // 全局成员规则只提供 flags；群内/私聊自己的规则优先
  const globalFlags = own(policy?.global, sender)?.flags;
  if (kind === 'private') return allow(normalizeFlags(own(policy?.private, sender) ?? globalFlags, defaultFlags));

  const pol = own(policy?.groups, `group:${id}`);
  // 名单模式非法时同样关闭回应与模型上下文，保留原始归档
  if (pol && !MEMBER_MODES.includes(pol.mode)) return allow({ respond: false, converse: false, context: false, memory: true }, 'policy-broken');
  gate.memberMode = pol?.mode ?? 'all';
  const rule = own(pol?.rules, sender);
  if (rule) gate.rule = { qq: Number(sender), ...(rule.note ? { note: String(rule.note) } : {}) };
  if (gate.memberMode === 'whitelist' && !rule) return deny('not-in-whitelist');
  if (gate.memberMode === 'blacklist' && rule) return deny('blacklisted');
  return allow(normalizeFlags(rule?.flags ?? globalFlags, defaultFlags));
}
