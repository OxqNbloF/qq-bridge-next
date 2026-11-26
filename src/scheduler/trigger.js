export const WAKE_PRIORITY = {
  private: 100, atMention: 90, question: 80, speaker: 75, nameMention: 70,
  keyword: 60, anyMessage: 50, replyCheck: 40, timeout: 30, proactiveCheck: 20,
};
const TIMER_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']);
export function wakePriority(reason) { return WAKE_PRIORITY[String(reason ?? '').split(':')[0]] ?? 0; }
export function isTimerReason(reason) { return TIMER_REASONS.has(String(reason ?? '').split(':')[0]); }
export function isDirectedReason(reason) { return ['private', 'atMention', 'nameMention', 'poke'].includes(String(reason ?? '').split(':')[0]); }
const RATE_LIMIT_EXEMPT_REASONS = new Set(['private', 'atMention', 'nameMention', 'poke', 'question', 'reply', 'admin']);
export function isRateLimitExemptReason(reason) { return RATE_LIMIT_EXEMPT_REASONS.has(String(reason ?? '').split(':')[0]); }

// 随机样本与名字由调用侧传入，同一输入永远得到同一判定。
export function evaluateTrigger({ kind, triggers: tr, event, plainContent, quoteTargetIsSelf, names, directed, random }) {
  if (kind === 'private') return 'private';
  if (tr.anyMessage) return 'anyMessage';
  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return 'atMention';
  }
  const lower = String(plainContent ?? '').toLowerCase();
  if (tr.nameMention && names.some((name) => lower.includes(String(name).toLowerCase()))) return 'nameMention';
  for (const kw of Array.isArray(tr.keywords) ? tr.keywords : []) {
    const value = String(kw ?? '').toLowerCase();
    if (!value) continue;
    if (/^[a-z0-9]+$/.test(value) && value.length <= 4) {
      if (new RegExp(`\\b${value}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      continue;
    }
    if (lower.includes(value)) return `keyword:${kw}`;
  }
  if (tr.question && directed) return 'question';
  const speaker = String(event?.user_id ?? event?.sender?.user_id ?? '');
  if (speaker && Array.isArray(tr.speakerIds) && tr.speakerIds.some((id) => String(id) === speaker)) {
    return `speaker:${event?.sender?.card || event?.sender?.nickname || speaker}`;
  }
  if (Number(tr.probability) > 0 && random < Number(tr.probability)) return 'probability';
  return null;
}
