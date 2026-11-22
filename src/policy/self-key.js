// 把 QQ 会话 key 编码进预分配的 DSH sessionId
// 注意：plugins/qq-agent-presets/qq-self-key.mjs 会被安装到 DSH 独立插件目录，因此保持零外部依赖；
// 两端的格式正则必须保持一致（qqb-[gp]-<正整数>[-<32位十六进制>]）。
import crypto from 'node:crypto';
import { canonicalV2Key } from './access.js';

// 工具调用不带会话来源，用 sessionId 绑定会话，防模型换 key 越权
export const BOUND_SESSION_ID_RE = /^qqb-[gp]-(\d{1,20})(?:-[a-f0-9]{32})?$/;

/** 把会话 key 编码成 sessionId；key 不合法返回 '' */
export function encodeSelfKey(key) {
  const canonical = canonicalV2Key(key);
  if (!canonical) return '';
  const [kind, id] = canonical.split(':');
  return `qqb-${kind === 'group' ? 'g' : 'p'}-${id}-${crypto.randomBytes(16).toString('hex')}`;
}
