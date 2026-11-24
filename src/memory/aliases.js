import crypto from 'node:crypto';
import { canonicalV2Key } from '../policy/access.js';
import { normalizeAliasText } from '../identity/registry.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createAliasMemory(b) {
  function appendAlias(key, content, extra = {}) {
    const conv = canonicalV2Key(key);
    const qq = String(extra.target ?? '');
    const text = String(content ?? '').trim();
    if (!conv || !/^[1-9]\d{0,15}$/.test(qq) || !text || text.length > 32 || /[\r\n【】]/.test(text) || SENSITIVE_RE.test(text)) throw new Error('称呼候选需要合法会话、extra.target QQ 和安全称呼');
    const id = `alias:${conv}:${crypto.createHash('sha256').update(qq + '\n' + normalizeAliasText(text)).digest('hex').slice(0, 12)}`;
    const now = new Date().toISOString();
    const old = b.memoryPool.query({ kind: 'alias', convId: conv, clone: false }).find(item => item.id === id && (!item.expire_at || Date.parse(item.expire_at) > Date.now()));
    const initEvidence = Array.isArray(extra.sourceMessageIds)
      ? [...new Set([...(Array.isArray(old?.evidence) ? old.evidence : []), ...extra.sourceMessageIds.map(String).filter(Boolean)])].slice(-50)
      : (old?.evidence ?? null);
    const item = { ...old, id, conv_id: conv, kind: 'alias', status: old?.status ?? 'candidate', content: text, subject_uid: qq,
      source_msg_ids: old?.source_msg_ids ?? [], ...(initEvidence?.length ? { evidence: initEvidence } : {}), created_at: old?.created_at ?? now, updated_at: now, expire_at: old?.expire_at ?? new Date(Date.now() + 30 * 86400000).toISOString() };
    b.memoryPool.update(items => {
      const own = [...items.filter(entry => entry.kind === 'alias' && entry.conv_id === conv && entry.id !== id && (!entry.expire_at || Date.parse(entry.expire_at) > Date.now())), item].slice(-200);
      return [...items.filter(entry => entry.kind !== 'alias' || entry.conv_id !== conv), ...own];
    });
    return item;
  }

  function observeAliasEvidence(envelope) {
    if (b.cfg.identity?.enabled === false || b.cfg.identity?.learnFromChat === false || !b.termsWritable || !b.identityWritable() || !envelope.flags.memory || !envelope.flags.context || !envelope.id) return;
    const key = `${envelope.conv.kind}:${envelope.conv.id}`;
    const text = normalizeAliasText(envelope.plain);
    try {
      const candidates = b.memoryPool.query({ kind: 'alias', convId: key, clone: false }).filter(item => item.status === 'candidate');
      if (!candidates.length) return;
      const updates = new Map();
      const expired = new Set();
      for (const item of candidates) {
        if (Date.parse(item.expire_at) <= Date.now()) { expired.add(item.id); continue; }
        if (!text.includes(normalizeAliasText(item.content))) continue;
        const explicit = envelope.mentions.some(mention => ['at', 'quote'].includes(mention.by) && String(mention.qq) === item.subject_uid)
          || new RegExp(`(^|\\D)${item.subject_uid}(\\D|$)`).test(envelope.plain);
        if (!explicit || item.source_msg_ids.includes(envelope.id)) continue;
        const ids = [...item.source_msg_ids, envelope.id];
        updates.set(item.id, { ...item, status: ids.length >= 2 ? 'active' : 'candidate', source_msg_ids: ids, expire_at: ids.length >= 2 ? null : item.expire_at });
      }
      if (!updates.size && !expired.size) return;
      b.memoryPool.update(items => items.filter(item => !expired.has(item.id)).map(item => updates.get(item.id) ?? item));
      for (const item of updates.values()) if (item.status === 'active') b.activateLearnedAlias({ qq: item.subject_uid, group: envelope.conv.kind === 'group' ? String(envelope.conv.id) : null, name: item.content, sources: item.source_msg_ids.map(id => ({ conv: item.conv_id, id: String(id) })) });
    } catch (error) { b.log(`[identity] 候选证据更新失败，保留正常消息处理：${error.message}`); }
  }
  return { appendAlias, observeAliasEvidence };
}
