import { canonicalV2Key } from '../policy/access.js';

// Context visibility is a read-time decision; stored privacy markers remain a floor.
export function modelMessageVisible(b, key, message) {
  if (!message || message.noContext || message.no_context) return false;
  if (!b.cfg.architecture?.gateV2) return true;
  const canonical = canonicalV2Key(key);
  if (!canonical) return false;
  const [kind, id] = canonical.split(':');
  const self = message.isSelf || message.from === 'bot'
    || (b.selfUserId && String(message.userId ?? message.user_id ?? '') === String(b.selfUserId));
  const sources = Array.isArray(message.sourceQqs) ? message.sourceQqs : [];
  const actors = [...sources];
  if (!self || kind === 'private') actors.push(self ? id : message.userId ?? message.user_id ?? (kind === 'private' ? id : undefined));
  return [...new Set(actors.map(String))].every(qq => {
    if (self && kind !== 'private' && b.selfUserId && qq === String(b.selfUserId)) return true;
    if (!/^[1-9]\d{0,15}$/.test(qq)) return false;
    const decision = b.gateDecide({ kind, id: Number(id), qq });
    return decision.allowed === true && decision.flags.context === true;
  });
}

const QQ_RE = /^[1-9]\d{0,15}$/;

export function modelMemberVisible(b, key, subjectUid, { isImpression = false } = {}) {
  if (!b.cfg.architecture?.gateV2 || !b.gateDecide) return true;
  const canonical = canonicalV2Key(key);
  if (!canonical) return false;
  const [kind, id] = canonical.split(':');
  if (kind === 'private') {
    const target = QQ_RE.test(String(subjectUid ?? '')) ? String(subjectUid) : id;
    const decision = b.gateDecide({ kind: 'private', id: Number(id), qq: target });
    return decision.allowed === true && decision.flags.context === true;
  }
  const raw = String(subjectUid ?? '').trim();
  if (!raw) return !isImpression;
  if (!QQ_RE.test(raw)) return isImpression ? false : raw === '我';
  const decision = b.gateDecide({ kind: 'group', id: Number(id), qq: raw });
  return decision.allowed === true && decision.flags.context === true;
}

export function modelStateKey(b, state) {
  for (const [key, value] of b.socialV2?.conversations ?? []) if (value === state) return key;
  return null;
}

export function modelHistoryState(b, key, state) {
  return { ...state,
    unread: (state.unread ?? []).filter(message => modelMessageVisible(b, key, message)),
    recentMessages: (state.recentMessages ?? []).filter(message => modelMessageVisible(b, key, message)),
  };
}
