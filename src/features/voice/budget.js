// 语音独立限流与"已发语音"记账
import { truncateText } from '../../md-to-plain.js';
import { canonicalV2Key } from '../../policy/access.js';

// 创建语音限流与记账函数，b 为桥接访问器
export function createVoiceBudget(b) {
  // 语音发送时间戳与在途预占计数，按规范化限流范围记录
  const voiceSendTimes = new Map();
  const voicePending = new Map();
  const normScope = (scopeKey) => canonicalV2Key(scopeKey) ?? String(scopeKey ?? '').trim();
  /** 语音限流错误；检查不占额度，发送前可预占，发出后记账 */
  class VoiceRateLimitError extends Error {
    // 标记为 429 错误
    constructor(message) {
      super(message);
      this.statusCode = 429;
    }
  }

  // 检查语音额度，超限抛 VoiceRateLimitError
  function voiceBudgetCheck(scopeKey, cfgV) {
    const k = normScope(scopeKey);
    const now = Date.now();
    const bucket = voiceSendTimes.get(k) ?? [];
    const pending = voicePending.get(k) ?? 0;
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + pending + 1 > cfgV.maxPerMinute) {
      throw new VoiceRateLimitError(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + pending + 1 > cfgV.maxPerHour) {
      throw new VoiceRateLimitError(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 发送前预占一个并发语音名额，防止异步 ffmpeg/发送期间并发穿透限流 */
  function voiceBudgetReserve(scopeKey, cfgV) {
    const k = normScope(scopeKey);
    voiceBudgetCheck(k, cfgV);
    voicePending.set(k, (voicePending.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (voicePending.get(k) ?? 1) - 1;
      if (next <= 0) voicePending.delete(k);
      else voicePending.set(k, next);
    };
  }

  /** 语音发出后记账，并裁掉 1 小时前的时间戳 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const k = normScope(scopeKey);
    const bucket = (voiceSendTimes.get(k) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(k, bucket);
  }

  /** 把"我发了语音"写进二代会话的 recentMessages */
  function recordVoiceSentV2(rawKey, sent, label) {
    const key = normScope(rawKey);
    const st = b.getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const now = Date.now();
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: false,
      ownerLabel: '',
      isSelf: true,
      time: now
    };
    st.recentMessages.push(entry);
    const recentLimit = Math.max(10, Number(b.cfg?.socialV2?.context?.recentLimit) || 100);
    if (st.recentMessages.length > recentLimit) st.recentMessages = st.recentMessages.slice(-recentLimit);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.wakeConfig.noActionCount = 0;
    b.saveSocialV2State();
  }

  return {
    voiceSendTimes, voiceBudgetCheck, voiceBudgetReserve, voiceBudgetCommit, recordVoiceSentV2, VoiceRateLimitError };
}
