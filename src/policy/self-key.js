// 把 QQ 会话 key 编码进预分配的 DSH sessionId
import crypto from 'node:crypto';
import { canonicalV2Key } from './access.js';

// 工具调用不带会话来源，用 sessionId 绑定会话，防模型换 key 越权
export const BOUND_SESSION_ID_RE = /^qqb-[gp]-\d+(?:-[a-f0-9]{32})?$/;

/** 把会话 key 编码成 sessionId；key 不合法返回 '' */
export function encodeSelfKey(key) {
  const canonical = canonicalV2Key(key);
  if (!canonical) return '';
  const [kind, id] = canonical.split(':');
  return `qqb-${kind === 'group' ? 'g' : 'p'}-${id}-${crypto.randomBytes(16).toString('hex')}`;
}
