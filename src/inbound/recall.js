// 处理撤回：把原文换成占位，并清掉由它算出的缓存
import { canonicalV2Key } from '../policy/access.js';

// 创建撤回事件处理器
export function createRecallHandler(b) {
    // 撤回的消息换成占位，不删条目（已读位置按序号走，不能留空）
  function handleRecallNotice(event) {
    const type = event?.notice_type;
    if (type !== 'group_recall' && type !== 'friend_recall') return false;
    const groupId = event?.group_id ?? event?.groupId ?? null;
    const key = groupId != null ? b.convKey('group', String(groupId)) : b.convKey('private', String(event?.user_id ?? ''));
    const canonical = canonicalV2Key(key);
    const messageId = event?.message_id != null ? String(event.message_id) : '';
    if (!canonical || !messageId) return false;
    // 底账只追加撤回记录；只记已在底账里的会话，不凭空建目录
    b.archiveSafely('撤回落盘', (archive) => {
      if (archive.lastSeq(canonical) > 0) archive.markRecalled(canonical, messageId, { operatorId: event?.operator_id ?? '' });
    });
    const st = b.socialV2.conversations.get(canonical);
    if (!st) return false;

    const originals = [...(st.recentMessages || []), ...(st.unread || [])]
      .filter((m) => m && String(m.messageId ?? '') === messageId);
    if (!originals.length) return false;

    // 占位保留 seq 与时间，正文换成撤回标记
    const placeholder = (m) => ({
      ...m,
      text: '[该消息已被撤回]',
      plain: '[该消息已被撤回]',
      tail: '',
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      recalled: true
    });
    for (const field of ['recentMessages', 'unread']) {
      st[field] = (st[field] || []).map((m) => (String(m?.messageId ?? '') === messageId ? placeholder(m) : m));
    }
        // 由它算出的缓存也要一起清，否则还会吐出原文
    for (const cached of b.replyInfoCache.keys()) {
      if (String(cached).startsWith(`${canonical}:`)) b.replyInfoCache.delete(cached);
    }
    const media = b.messageMediaStore.get(canonical);
    if (media) {
      media.delete(messageId);
      for (const m of originals) if (m.seq != null) media.delete(String(m.seq));
    }
    for (const m of originals) {
      for (const fid of m.forwardIds || []) b.seenForwardIds.get(canonical)?.delete(String(fid));
    }
    b.saveSocialV2State();
    b.log(`已处理撤回：${canonical} messageId=${messageId}`);
    return true;
  }

  return { handleRecallNotice };
}
