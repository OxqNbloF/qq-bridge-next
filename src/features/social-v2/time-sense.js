// 让 AI 知道消息是多久以前的，别把旧话当成刚说的
export function createTimeSenseV2(b) {
  // 醒来先算清楚：消息多旧、为什么被叫醒，再决定怎么开口
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  /** 本地 HH:MM（与消息 at 字段同一口径）。 */
  function localClockText(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // 读出「多久算旧消息」的两个分钟数
  function timeSenseCfg() {
    const wake = b.cfg.socialV2?.wake ?? {};
    // 把配置里的数字限制在合理范围
    const boundedMin = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : fallback;
    };
    const chatMin = boundedMin(wake.staleChatMinutes, 10, 1, 600);
    // 「默认不回」的时间不能比「不算实时」还早，否则规则打架
    const silentMin = Math.max(chatMin, boundedMin(wake.staleSilentMinutes, 120, 5, 2880));
    return { chatMin, silentMin };
  }

  /** 叫醒原因里带的本地消息号，没有就返回空。 */
  function wakeReasonSeq(reason) {
    const match = /@seq(\d+)$/.exec(String(reason ?? '').trim());
    if (!match) return null;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  }

  // 按消息编号在未读和最近消息里找那条
  function findV2MessageBySeq(st, seq) {
    if (!st || !Number.isSafeInteger(seq)) return null;
    for (const list of [st.unread, st.recentMessages]) {
      const hit = (Array.isArray(list) ? list : []).find((m) => m && m.seq === seq);
      if (hit) return hit;
    }
    return null;
  }

  /** 生成「消息多旧、该怎么接话」的一段规则文字 */
  function buildTimeSenseLine(st) {
    const now = Date.now();
    const newest = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf)
      || [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf)
      || null;
    if (!newest) return '';
    const ageText = b.describeAge(newest.time, now);
    if (!ageText) return '';
    const { chatMin, silentMin } = timeSenseCfg();
    const sender = String(newest.sender || '未知');
    const ageMin = Math.max(0, Math.floor((now - Number(newest.time)) / 60000));
    const staleNow = ageMin >= chatMin;
    const tooOld = ageMin >= silentMin;
    const lines = [
      `【时间感：先看消息多旧，再决定怎么开口】现在 ${localClockText(now)}；最新一条来自「${sender}」，是 ${ageText} 之前发的（${localClockText(newest.time)}）。`,
      '- 消息里的 at 是本地时间、ago 是距现在多久；开口前先确认最新那条的 ago，不要凭感觉当成"刚刚"。',
      `- ${chatMin} 分钟以内：正常接，当实时对话。`
    ];
    // 只有两档时间真不一样时才写中间档，不然自相矛盾
    if (silentMin > chatMin) {
      lines.push(`- ${chatMin}～${silentMin} 分钟：可以接，但别用"刚""哈哈哈刚看到"这类实时语气；先确认这个话题还在不在、对方还在不在。`);
    }
    lines.push(`- 超过 ${silentMin} 分钟：默认不回，直接 qq_mark_read 收尾；只有当那条明确是找你/提问你、而且回答现在仍然有用时才回，并且开头要带时间感（"这条我才看到""过了挺久才看到"）。`);
    if (staleNow) {
      lines.push(`⚠️ 本次属于「旧账」：最新消息已经是 ${ageText} 前，${tooOld ? `超过 ${silentMin} 分钟` : `超过 ${chatMin} 分钟`}。不要用秒回语气，也不要把别人的旧话题当现在的事接。`);
    }
    return `${lines.join('\n')}\n\n`;
  }

  // 唤醒时给 AI 看的一小段消息快照
  function buildWakeSnapshotV2(key) {
    const context = b.cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!b.v2ToolEnabled('getUnread') && !b.v2ToolEnabled('getRecent'))) return null;
    const st = b.getSocialV2State(key);
    // 把配置里的数字限制在合理范围
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 一次快照只取一次 now：同一批消息的 ago 必须彼此可比。
    const now = Date.now();
    const newestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse()
      .find((m) => m && !m.isSelf) || null;
    const newestAgo = newestIncoming ? b.describeAge(newestIncoming.time, now) : '';
    const packet = {
      messages: [],
      recent: [],
      // now / newestAgo 让模型不必自己换算：最新一条多旧，直接写在快照头上。
      now: localClockText(now),
      ...(newestAgo ? { newestAgo } : {}),
      unreadCount: st.unread.length,
      includedUnreadCount: 0,
      readThroughSeq: b.readThroughSeqV2(st),
      partial: st.unread.length > 0
    };
    // 试着放一条消息，超过字数就撤回
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(b.compactModelMessage(msg, { now }));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = b.readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (b.v2ToolEnabled('getUnread')) {
      // 从最旧的未读开始，不能悄悄跳过没看过的消息
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (b.v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  // 算这次回复前该等多久
  function replyTimingV2(st) {
    const minimum = Number(b.cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(b.cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(b.suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 告诉 AI 自己的昵称和 QQ 号，别把 @自己 当成别人
  function selfIdentityTextV2() {
    const name = String(b.selfDisplayName || '').trim();
    const id = String(b.selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  return { pad2, localClockText, timeSenseCfg, wakeReasonSeq, findV2MessageBySeq, buildTimeSenseLine, buildWakeSnapshotV2, replyTimingV2, selfIdentityTextV2 };
}
