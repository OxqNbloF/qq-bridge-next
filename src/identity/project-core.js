// 模型视图投影共享核心：HTTP 模型表面与 MCP 历史网关共用同一套字段掩码与 QQ 号脱敏规则
export const IDENTITY_FIELDS = [
  'qq', 'userId', 'user_id', 'subject_uid',
  'targetId', 'target_id', 'targetUserId', 'target_user_id',
  'senderId', 'sender_id', 'senderUserId', 'sender_user_id',
];
export const HIDDEN_IDENTITY_FIELDS = ['qq', 'userId', 'user_id', 'isOwner', 'subject_uid', 'qqs'];
export const MESSAGE_ID_FIELDS = [
  'id', 'seq', 'messageId', 'message_id', 'msgId', 'msg_id',
  'replyToMessageId', 'source_msg_ids', 'sourceMessageIds', 'forwardIds',
  'readThroughSeq', 'afterSeq', 'requestSeq', 'lastUnreadSeq', 'lastReadThroughSeq',
];

const CONV_KEY_RE = /^(group|private):[1-9]\d{0,15}$/;
const BARE_QQ_RE = /(?<!\d)[1-9]\d{0,15}(?!\d)/g;
const QQ_PREFIX_RE = /(?:ownerQQ|QQ|qq|user_id|userId|uin|at|@)\s*[:：=]?\s*$/;

/** 从一个或多个原始数据根中收集已知 QQ 号，保证被过滤成员的文本提及同样脱敏 */
export function collectIdentityIds(roots, { seedIds = [], keyFields = [] } = {}) {
  const ids = new Set(Array.from(seedIds, String).filter(Boolean));
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [name, child] of Object.entries(node)) {
      if (IDENTITY_FIELDS.includes(name) && /^[1-9]\d*$/.test(String(child))) ids.add(String(child));
      if (keyFields.includes(name) && child && typeof child === 'object') {
        for (const id of Object.keys(child)) if (/^[1-9]\d*$/.test(id)) ids.add(id);
      }
      collect(child);
    }
  };
  for (const root of roots) collect(root);
  return ids;
}

/** 将数据投影为不含明文 QQ 的模型视图 */
export function projectModelTree(value, { collectRoots = [value], seedIds = [], keyFields = [], displayName, transformFieldValue } = {}) {
  const ids = collectIdentityIds(collectRoots, { seedIds, keyFields });
  const labelOf = (id) => displayName?.(String(id)) || '群友';
  const project = (node, field = '') => {
    if (Array.isArray(node)) return node.map((child) => project(child, field));
    if ((!node || typeof node !== 'object') && MESSAGE_ID_FIELDS.includes(field)) return node;
    if (typeof node === 'string' && CONV_KEY_RE.test(node)) return node;
    if (typeof node === 'string') {
      return node.replace(BARE_QQ_RE, (id, offset) => (
        ids.has(id) || QQ_PREFIX_RE.test(node.slice(0, offset)) ? labelOf(id) : id
      ));
    }
    if (typeof node === 'number' && ids.has(String(node))) return labelOf(node);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([name]) => !HIDDEN_IDENTITY_FIELDS.includes(name))
        .map(([name, child]) => [name, transformFieldValue ? transformFieldValue(name, child, project) : project(child, name)])
    );
  };
  return project(value);
}
