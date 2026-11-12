// 语音独立限流与"已发语音"记账
import { truncateText } from '../../md-to-plain.js';

// 创建语音限流与记账函数，b 为桥接访问器
export function createVoiceBudget(b) {
  // 语音发送时间戳，按限流范围记录
  const voiceSendTimes = new Map();
  /** 语音限流错误；检查不占额度，发出后才记账 */
  class VoiceRateLimitError extends Error {
    // 标记为 429 错误
    constructor(message) {
      super(message);
      this.statusCode = 429;
    }
  }

  // 检查语音额度，超限抛 VoiceRateLimitError
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new VoiceRateLimitError(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new VoiceRateLimitError(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音发出后记账，并裁掉 1 小时前的时间戳 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /** 把"我发了语音"写进二代会话的 recentMessages */
  function recordVoiceSentV2(key, sent, label) {
    const st = b.getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: false,
      ownerLabel: '',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    b.saveSocialV2State();
  }

  return {
    voiceSendTimes, voiceBudgetCheck, voiceBudgetCommit, recordVoiceSentV2, VoiceRateLimitError };
}
