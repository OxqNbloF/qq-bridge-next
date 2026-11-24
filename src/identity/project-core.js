// 模型视图投影共享核心：HTTP 模型表面与 MCP 历史网关共用同一套字段掩码与 QQ 号脱敏规则
import crypto from 'node:crypto';

export const IDENTITY_FIELDS = [
  'qq', 'userId', 'user_id', 'subject_uid', 'sourceQqs', 'senderQq',
  'targetId', 'target_id', 'targetUserId', 'target_user_id',
  'senderId', 'sender_id', 'senderUserId', 'sender_user_id',
  'speakerIds',
];
export const HIDDEN_IDENTITY_FIELDS = ['qq', 'userId', 'user_id', 'isOwner', 'ownerLabel', 'subject_uid', 'qqs', 'sourceQqs', 'senderQq'];
export const MESSAGE_ID_FIELDS = [
  'id', 'seq', 'messageId', 'message_id', 'msgId', 'msg_id',
  'replyToMessageId', 'source_msg_ids', 'sourceMessageIds', 'forwardIds',
  'readThroughSeq', 'afterSeq', 'requestSeq', 'lastUnreadSeq', 'lastReadThroughSeq',
];
const IDENTITY_FIELD_SET = new Set(IDENTITY_FIELDS);
const HIDDEN_IDENTITY_FIELD_SET = new Set(HIDDEN_IDENTITY_FIELDS);
const MESSAGE_ID_FIELD_SET = new Set(MESSAGE_ID_FIELDS);
const DATA_IMAGE_URI_RE = /^(?:data:image\/[a-z0-9.+-]+;base64,|base64:\/\/)[A-Za-z0-9+/=_-]+$/i;

const CONV_KEY_RE = /^(group|private):[1-9]\d{0,15}$/;
const BARE_QQ_RE = /(?<!\d)[1-9]\d{0,15}(?!\d)/g;
const QQ_PREFIX_RE = /(?:(?<![A-Za-z0-9_])(?:ownerQQ|QQ|qq|user_id|userId|uin)\s*[:：=]?\s*$|@\s*[:：=]?\s*$|(?<![A-Za-z0-9_])at\s*[:=]\s*$)/;
const PREFIXED_QQ_WIDTH_RE = /^[1-9]\d{4,11}$/;
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/i;
export const MEMBER_REF_RE = /^member-[0-9a-f]{16}$/;
export const memberRef = (id) => `member-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;

/** 判断是否为图片载荷的纯 Base64 字节字段，避免文本脱敏破坏图片编码 */
export function isImageBase64Field(parent, field, value) {
  if (field !== 'data' || typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
  const mime = parent.mimeType ?? parent.mediaType;
  if (typeof mime !== 'string' || !IMAGE_MIME_RE.test(mime)) return false;
  if (/[^A-Za-z0-9+/=]/.test(value)) return false;
  const eq = value.indexOf('=');
  return eq === -1 || eq === value.length - 1 || (eq === value.length - 2 && value[value.length - 1] === '=');
}

/** 从一个或多个原始数据根中收集已知 QQ 号，保证被过滤成员的文本提及同样脱敏 */
export function collectIdentityIds(roots, { seedIds = [], keyFields = [] } = {}) {
  const ids = new Set(Array.from(seedIds, String).filter(Boolean));
  const keyFieldSet = new Set(keyFields);
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) collect(node[i]);
      return;
    }
    for (const [name, child] of Object.entries(node)) {
      if (IDENTITY_FIELD_SET.has(name)) {
        if (Array.isArray(child)) {
          for (const item of child) if (/^[1-9]\d*$/.test(String(item))) ids.add(String(item));
        } else if (/^[1-9]\d*$/.test(String(child))) {
          ids.add(String(child));
        }
      }
      if (keyFieldSet.has(name) && child && typeof child === 'object') {
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
    if ((!node || typeof node !== 'object') && MESSAGE_ID_FIELD_SET.has(field)) return node;
    if (typeof node === 'string' && (CONV_KEY_RE.test(node) || MEMBER_REF_RE.test(node) || DATA_IMAGE_URI_RE.test(node))) return node;
    if (typeof node === 'string') {
      return node.replace(BARE_QQ_RE, (id, offset) => (
        ids.has(id) || (PREFIXED_QQ_WIDTH_RE.test(id) && QQ_PREFIX_RE.test(node.slice(Math.max(0, offset - 32), offset))) ? labelOf(id) : id
      ));
    }
    if (typeof node === 'number' && ids.has(String(node))) return labelOf(node);
    if (!node || typeof node !== 'object') return node;
    const entries = Object.entries(node)
      .filter(([name]) => !HIDDEN_IDENTITY_FIELD_SET.has(name))
      .map(([name, child]) => [
        name,
        isImageBase64Field(node, name, child)
          ? child
          : (transformFieldValue ? transformFieldValue(name, child, project) : project(child, name)),
      ]);
    const rawMemberId = Object.prototype.hasOwnProperty.call(node, 'userId') ? node.userId
      : Object.prototype.hasOwnProperty.call(node, 'user_id') ? node.user_id : undefined;
    if (/^[1-9]\d*$/.test(String(rawMemberId ?? '').trim()) && !Object.prototype.hasOwnProperty.call(node, 'memberRef')) {
      entries.push(['memberRef', memberRef(String(rawMemberId).trim())]);
    }
    return Object.fromEntries(entries);
  };
  return project(value);
}
