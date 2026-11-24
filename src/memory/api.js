import { COMPRESS_KINDS } from './compress.js';
import { assertMemoryWriteAllowed } from './write-guard.js';
import { canonicalV2Key } from '../policy/access.js';
import { normalizeAliasText } from '../identity/registry.js';
import { resetMemoryContext } from './context-reset.js';

export function createMemoryAPI(b) {
  function assertWritable(key, category) {
    key = canonicalV2Key(key);
    if (!key) throw Object.assign(new Error('会话 key 非法'), { statusCode: 400 });
    const policy = b.modeAdapterForKey(key)?.memoryPolicy;
    if (!policy?.write?.includes(category)) throw Object.assign(new Error('当前模式不允许写入该记忆类别'), { statusCode: 403 });
    return key;
  }
  function append(key, category, content, extra = {}) {
    key = assertWritable(key, category);
    const st = b.getSocialV2State(key);
    const sources = extra.sourceMessageIds ?? extra.source_msg_ids ?? st.recentMessages.filter(item => !b.cfg.architecture?.gateV2 || (!item.noContext && (item.isSelf || /^[1-9]\d{0,15}$/.test(String(item.userId))))).slice(-50).map(item => item.messageId).filter(Boolean);
    assertMemoryWriteAllowed(b, key, { state: st, targetQq: category === 'alias' ? extra.target : undefined, sourceMessageIds: sources });
    extra = { ...extra, sourceMessageIds: [...new Set(sources.map(String))] };
    if (category === 'term') return b.terms.append(key, content, { ...extra, source: 'ai' });
    if (category === 'alias') return b.appendAlias(key, content, extra);
    b.appendMemoryV2(st, category, content, extra, key);
    return { key, category, content };
  }
  function retrieve(rawKey, category, query = '') {
    const key = canonicalV2Key(rawKey) ?? String(rawKey ?? '').trim();
    if (category === 'term') return b.terms.query(key, query);
    const kinds = { activeTopic: 'ongoing', pendingThought: 'ongoing', memberImpression: 'impression' };
    return b.memoryPool.query({ kind: kinds[category] ?? category }).filter(item => (!item.expire_at || Date.parse(item.expire_at) > Date.now()) && item.conv_id === key
      && (category !== 'activeTopic' || item.subtype === 'topic') && (category !== 'pendingThought' || item.subtype === 'thought')
      && (!query || String(item.content).includes(query)));
  }
  function remove(key, category, content) {
    if (category === 'term') return b.terms.remove(key, content);
    if (['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
      const state = b.getSocialV2State(key);
      if (category === 'activeTopic') state.activeTopics = content === undefined ? [] : state.activeTopics.filter(item => item.text !== content);
      if (category === 'pendingThought') state.pendingThoughts = content === undefined ? [] : state.pendingThoughts.filter(item => item.text !== content);
      if (category === 'memberImpression') { if (content === undefined) state.memberImpressions = {}; else delete state.memberImpressions[content]; }
      b.saveSocialV2State(); return;
    }
    key = canonicalV2Key(key);
    if (!key) throw Object.assign(new Error('会话 key 非法'), { statusCode: 400 });
    const text = category === 'alias' && content !== undefined ? String(content).trim() : content;
    if (category === 'alias' && text !== undefined && !text) throw Object.assign(new Error('删除需要 content'), { statusCode: 400 });
    const contentMatch = (item) => text === undefined
      || (category === 'alias' ? normalizeAliasText(item.content) === normalizeAliasText(text) : item.content === text);
    const matches = (item) => item.conv_id === key && item.kind === category && contentMatch(item);
    if (category === 'alias') {
      const targets = b.memoryPool.query({ kind: 'alias' }).filter(matches);
      b.revokeIdentityAliases?.(key, { removed: targets, content: text, clearAll: text === undefined });
    }
    b.memoryPool.update(items => items.filter(item => !matches(item)));
    b.memoryIndex.drop(key); b.removeMemoryView({ convId: key });
  }
  return {
    record: envelope => envelope.flags.memory ? b.archiveIncoming(`${envelope.conv.kind}:${envelope.conv.id}`, envelope.raw, { textContent: envelope.text, plainContent: envelope.plain, mediaList: envelope.media, noContext: !envelope.flags.context, sourceQqs: envelope.sourceQqs }) : undefined,
    append, retrieve, remove, assertWritable,
    clear: (key, category) => category ? remove(key, category) : ['activeTopic', 'pendingThought', 'memberImpression'].forEach(kind => remove(key, kind)),
    buildContext: (key, policy) => {
      const text = b.getMemoryContext(key, b.getSocialV2State(key), policy);
      const limit = policy?.maxChars ?? 1500;
      const chars = Array.from(String(text ?? ''));
      return chars.length <= limit ? String(text ?? '') : chars.slice(0, limit).join('');
    },
    forget: key => b.forgetConversationMemory(key),
    resetContext: (key, options) => resetMemoryContext(b, key, options),
    migrate: () => b.terms.migrate(),
    longKinds: COMPRESS_KINDS,
  };
}
