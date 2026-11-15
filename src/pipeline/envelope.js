// 消息管线：OneBot 事件 → MessageEnvelope（docs/architecture-refactor.md §2.3 / §3）
// 只解析与归一，不判权限、不写状态、不拼提示词。
import { segmentsToText, extractMediaFromSegments } from '../inbound/normalize.js';

const posInt = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** 结构化指认：渲染成文本之前先留住被 @ 的 QQ 和引用的消息号 */
export function parseSegments(segments) {
  const at = [];
  let quoteId = '';
  for (const seg of Array.isArray(segments) ? segments : []) {
    const d = seg?.data ?? {};
    if (seg?.type === 'at') {
      const qq = posInt(d.qq); // @全体 不是某个人
      if (qq && !at.includes(String(qq))) at.push(String(qq));
    } else if (seg?.type === 'reply' && !quoteId && d.id != null) quoteId = String(d.id);
  }
  return { at, quoteId };
}

/**
 * 构造信封；必填缺失（bad_event）返回 null
 * resolveAtName / resolveReply 与 segmentsToText 的同名选项一致，文本因此与旧入口逐字节相同
 */
export async function buildEnvelope(kind, event, { convId: convIdOverride, resolveAtName, resolveReply, resolveDisplayName, resolveAliases, resolveAlias, resolveMentions, ownerQQ } = {}) {
  const convId = posInt(convIdOverride ?? (kind === 'group' ? event?.group_id : event?.user_id));
  const qq = posInt(event?.user_id);
  if ((kind !== 'group' && kind !== 'private') || !convId || !qq) return null;

  const message = event.message ?? [];
  // 引用只查一次：文本渲染和 quote 字段共用
  const replies = new Map();
  const reply = resolveReply && ((id) => {
    if (!replies.has(id)) replies.set(id, Promise.resolve().then(() => resolveReply(id)));
    return replies.get(id);
  });
  const text = await segmentsToText(message, { resolveAtName, resolveReply: reply });
  const plain = await segmentsToText(message, { resolveAtName, includeReply: false });
  const { at, quoteId } = parseSegments(message);
  let quote;
  if (quoteId) {
    let info = null;
    try { info = reply ? await reply(quoteId) : null; } catch { info = null; }
    const senderQq = posInt(info?.userId);
    quote = { messageId: quoteId, ...(senderQq ? { senderQq } : {}), text: String(info?.text ?? '') };
  }
  const textMentions = at.length || quote?.senderQq ? [] : resolveMentions ? resolveMentions(plain) : [resolveAlias?.(plain)].filter(Boolean);

  const s = event.sender ?? {};
  const mentions = [
    ...at.map((target) => ({ qq: target, by: 'at' })),
    ...(quote?.senderQq ? [{ qq: String(quote.senderQq), by: 'quote' }] : []),
    ...textMentions.map(mention => ({ ...mention, by: mention.ambiguous ? 'text:ambiguous' : `text:${mention.by}` })),
  ].filter((mention, index, all) => mention.ambiguous || all.findIndex((item) => item.qq === mention.qq) === index);
  return {
    id: String(event.message_id ?? event.msg_id ?? event.message_seq ?? ''),
    seq: 0, // 归档写入时回填
    conv: { kind, id: convId },
    sender: {
      qq,
      displayName: String(resolveDisplayName?.(qq, kind, convId) || (kind === 'group' ? s.card || s.nickname : s.nickname) || qq),
      aliases: resolveAliases?.(qq, kind, convId) ?? [],
      isOwner: String(qq) === String(ownerQQ ?? ''),
    },
    text,
    plain,
    segments: Array.isArray(message) ? message : [],
    ...(quote ? { quote } : {}),
    // 被拼入 text 的正文作者；@/别名指认不代表其正文被读取。
    sourceQqs: [...new Set([String(qq), ...(quote?.text && quote.senderQq ? [String(quote.senderQq)] : [])])],
    at,
    mentions,
    media: extractMediaFromSegments(Array.isArray(message) ? message : []),
    ts: Number(event.time) > 0 ? Number(event.time) * 1000 : Date.now(),
    flags: null, // 只由门禁写
    gate: null,
    raw: event, // 仅审计/排障，禁止进提示词与工具返回
  };
}
