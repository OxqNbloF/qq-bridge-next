// 一代仿真社交状态机：idle/active/probe/exit 与指向性判定
import { truncateText } from '../../md-to-plain.js';

// 创建一代社交状态机，b 为桥接访问器
export function createSocialStateMachineV1(b) {
  // 该会话是否启用一代社交
  function isSocialEnabled() {
    return b.currentMode === 'reserved' && b.cfg.social?.enabled !== false;
  }

  // 取或新建会话的社交状态
  function socialState(key) {
    if (!b.social.states.has(key)) {
      b.social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return b.social.states.get(key);
  }

  // 是否明确对 AI 说话：@、提名字、必回关键词、管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (b.selfNickname && (lower.includes('@' + b.selfNickname) || lower.includes(b.selfNickname))) return true;
    for (const kw of (b.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否直接针对 AI 提问、挑战或催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是…还是…/你是…吗"
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期判断必须回：昵称、关键词或直接提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (b.selfNickname && (lower.includes('@' + b.selfNickname) || lower.includes(b.selfNickname))) return true;
    for (const kw of (b.cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 追加一条最近消息并裁剪长度
  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!b.social.recentMessages.has(key)) b.social.recentMessages.set(key, []);
    const arr = b.social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(b.cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  // 追加一条待投喂摘要
  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!b.social.pendingSummaries.has(key)) {
      b.social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = b.social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  // 拼出投给模型的前后文段落
  function buildContextBlock(key) {
    const ctx = (b.social.recentMessages.get(key) ?? []).slice(-Number(b.cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${b.sanitizeUntrustedText(m.sender)}：${b.sanitizeUntrustedText(m.text)}${b.mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 进入活跃阶段
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + b.randInt(Number(b.cfg.social?.activeCheckMinMs ?? 20000), Number(b.cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 随机一个最长活跃时长，到点主动退场（仅群聊）
    if (key.startsWith('group:') && b.cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + b.randInt(
        Number(b.cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(b.cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  // 取消会话的社交定时器
  function cancelSocialTimers(key) {
    const timers = b.social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) b.clearTimeout(t);
    b.social.pendingTimers.delete(key);
  }

  // 取消所有会话的社交定时器
  function cancelAllSocialTimers() {
    for (const timers of b.social.pendingTimers.values()) {
      for (const t of timers) b.clearTimeout(t);
    }
    b.social.pendingTimers.clear();
  }

  // 离开仿真模式时清空社交状态和定时器
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    b.social.states.clear();
    b.social.recentMessages.clear();
    b.messageMediaStore.clear();
    b.social.pendingSummaries.clear();
    b.social.silentContext.clear();
    b.social.silentTurns.clear();
    b.social.exitingSessions.clear();
    // 拒绝排队中的 prompt，防调用方永远挂起
    for (const [, entry] of b.promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    b.promptQueues.clear();
  }

  // 离开活跃阶段回到观望
  function leaveActive(key) {
    cancelSocialTimers(key);
    b.social.states.delete(key);
    b.social.silentContext.delete(key);
  }

  // 活跃期只贴新消息；allowSilent=false 时不给 [SILENT]

  return { isSocialEnabled, socialState, isDirectAddress, isDirectedAtAi, isMustReplyText, appendRecentMessage, appendSummary, buildContextBlock, enterActive, cancelSocialTimers, cancelAllSocialTimers, cleanupSocialForModeChange, leaveActive };
}
