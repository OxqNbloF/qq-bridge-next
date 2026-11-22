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
    // 精确清理被撤回消息的引用缓存、媒体缓存与一代社交缓冲（不误伤同会话其他缓存，不依赖 v2 会话是否存在）
    let cleaned = false;
    if (b.replyInfoCache?.delete(`${canonical}:${messageId}`)) cleaned = true;
    const media = b.messageMediaStore?.get(canonical);
    if (media && media.delete(messageId)) cleaned = true;
    // 清理一代社交缓冲（recentMessages / pendingSummaries / silentContext）
    const scrubV1List = (list) => {
      if (!Array.isArray(list)) return false;
      let hit = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].messageId ?? '') === messageId) {
          list[i] = { ...list[i], text: '[该消息已被撤回]', plain: '[该消息已被撤回]', media: [], hasMedia: false, recalled: true };
          hit = true;
        }
      }
      return hit;
    };
    if (scrubV1List(b.social?.recentMessages?.get(canonical))) cleaned = true;
    if (scrubV1List(b.social?.pendingSummaries?.get(canonical)?.items)) cleaned = true;
    if (scrubV1List(b.social?.silentContext?.get(canonical))) cleaned = true;

    const st = b.socialV2.conversations.get(canonical);
    if (!st) {
      if (cleaned) b.log(`已处理撤回（缓存/一代缓冲）：${canonical} messageId=${messageId}`);
      return cleaned;
    }

    const originals = [...(st.recentMessages || []), ...(st.unread || [])]
      .filter((m) => m && String(m.messageId ?? '') === messageId);
    if (!originals.length) {
      if (cleaned) b.log(`已处理撤回（缓存/一代缓冲）：${canonical} messageId=${messageId}`);
      return cleaned;
    }

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
    if (media) {
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
