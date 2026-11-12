// 把 QQ 聊天编号和系统会话编号互相转换的唯一实现。
// 会话编号由桥接提前分配，模型改不了它。

/** 会话编号的前缀格式：qqb-群/私聊-编号 */
const BOUND_ID_RE = /^qqb-([gp])-(\d{1,20})(?:-[a-f0-9]{32})?$/;

/** 把 QQ 聊天编号转成系统会话编号；不合法返回空串 */
export function encodeSelfKey(key) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  // 必须是正数，防止带前导零的写法绕过检查
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `qqb-${m[1] === 'group' ? 'g' : 'p'}-${id}`;
}

/** 从系统会话编号还原 QQ 聊天编号；不是桥接建的返回空串 */
export function decodeSelfKey(sessionId) {
  const m = BOUND_ID_RE.exec(String(sessionId ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1] === 'g' ? 'group' : 'private'}:${id}`;
}

/** 统一的拒绝提示：所有拒绝长得一样，防止被试探 */
export const SESSION_UNAVAILABLE = '该会话不可用';

/** 从工具执行记录里取出可信的会话编号 */
export function trustedSelfKeyOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return decodeSelfKey(id);
}

/** 统一 QQ 聊天编号的写法：去掉前导零并检查是正数 */
export function canonicalKeyOf(value) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(value ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1]}:${id}`;
}

// 这几个只读工具不需要会话编号；新工具默认都需要
const QQ_TOOLS_WITHOUT_SESSION_KEY = new Set(['qq_status', 'qq_list_groups', 'qq_get_group_history']);
const QQ_LEGACY_SEND_TARGETS = {
  qq_send_group_message: ['group', 'groupId'], qq_reply: ['group', 'groupId'],
  qq_send_private_message: ['private', 'userId'], qq_send_burst: ['group', 'groupId']
};
const QQ_TARGET_ALIAS_TOOLS = new Set(['qq_send_message', 'qq_get_message_detail']);

/** 判断这次工具调用是不是指向当前会话；没绑定就拒绝 */
export function sessionBindingDenial(exec, args) {
  const name = /^mcp__snowluma__(.+)$/.exec(String(exec?.name ?? ''))?.[1] ?? '';
  const requiresKey = name !== '' && !QQ_TOOLS_WITHOUT_SESSION_KEY.has(name);
  const input = args && typeof args === 'object' ? args : {};
  const hasKey = Object.prototype.hasOwnProperty.call(input, 'key');
  const hasTarget = QQ_TARGET_ALIAS_TOOLS.has(name) && Object.prototype.hasOwnProperty.call(input, 'target');
  const legacyTarget = Object.prototype.hasOwnProperty.call(QQ_LEGACY_SEND_TARGETS, name) ? QQ_LEGACY_SEND_TARGETS[name] : null;
  if (legacyTarget) {
    const [kind, field] = legacyTarget;
    const canonical = canonicalKeyOf(`${kind}:${String(input[field] ?? '').trim()}`);
    const self = trustedSelfKeyOf(exec);
    if (!self || !canonical || canonical !== self) return SESSION_UNAVAILABLE;
    if (hasKey && canonicalKeyOf(input.key) !== canonical) return SESSION_UNAVAILABLE;
    if (Object.prototype.hasOwnProperty.call(input, 'target') && canonicalKeyOf(input.target) !== canonical) return SESSION_UNAVAILABLE;
    return '';
  }
  if (!hasKey && !hasTarget) return requiresKey ? SESSION_UNAVAILABLE : '';
  const self = trustedSelfKeyOf(exec);
  const canonical = canonicalKeyOf(hasKey ? input.key : input.target);
  if (hasKey && hasTarget && canonical !== canonicalKeyOf(input.target)) return SESSION_UNAVAILABLE;
  if (!self || !canonical || canonical !== self) return SESSION_UNAVAILABLE;
  return '';
}
