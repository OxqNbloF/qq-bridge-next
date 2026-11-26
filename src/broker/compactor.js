// 自动上下文压缩器：当 input_tokens 达到阈值时提炼 <=400 字滚动摘要并重置后端会话

function clipSummary(text, maxChars = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 创建上下文自动压缩器 */
export function createContextCompactor(b) {
  const inFlight = new Set();

  function buildRollingSummary(key, usage) {
    const parts = [];
    const role = b.readRoleState?.()?.role;
    if (role) parts.push(`角色=${role}`);
    if (key) parts.push(`会话=${key}`);
    const social = key ? b.getSocialV2State?.(key) : null;
    if (social) {
      if (Number.isFinite(Number(social.lastReadSeq))) parts.push(`lastReadSeq=${social.lastReadSeq}`);
      const recent = Array.isArray(social.unread) && social.unread.length
        ? social.unread.slice(-3).map((m) => `${m.senderName || m.userId || '成员'}:${String(m.text || '').slice(0, 40)}`).join(' | ')
        : '';
      if (recent) parts.push(`近期=${recent}`);
    }
    const mode = key ? b.modeForKey?.(key) : '';
    if (mode) parts.push(`模式=${mode}`);
    const tokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
    if (tokens > 0) parts.push(`压缩前tokens=${tokens}`);
    const body = parts.length ? parts.join('；') : '会话上下文过长，已自动压缩重置';
    return clipSummary(`[自动压缩摘要] ${body}`, 400);
  }

  function observeUsage(sessionId, usage) {
    if (!b.cfg?.broker?.enabled) return { compacted: false, reason: 'broker_disabled' };
    if (!sessionId || !usage || typeof usage !== 'object') return { compacted: false, reason: 'invalid_args' };
    const threshold = Number(b.cfg?.broker?.compactThresholdTokens) || 48000;
    const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
    if (!Number.isFinite(inputTokens) || inputTokens < threshold) {
      return { compacted: false, reason: 'below_threshold', inputTokens, threshold };
    }
    if (inFlight.has(sessionId)) {
      return { compacted: false, reason: 'in_flight' };
    }
    const resetFn = b.api?.resetConversationForCompaction;
    if (typeof resetFn !== 'function') {
      return { compacted: false, reason: 'no_backend_reset' };
    }

    const key = b.reverse?.get?.(sessionId) || '';
    const summary = buildRollingSummary(key, usage);
    inFlight.add(sessionId);
    try {
      const result = resetFn.call(b.api, sessionId, summary);
      b.log?.(`🧹 会话 ${sessionId} (${key || 'unknown'}) input_tokens=${inputTokens} >= ${threshold}，触发自动压缩`);
      if (result && typeof result.then === 'function') {
        return result.then(
          (res) => ({ compacted: true, sessionId, key, summary, inputTokens, result: res }),
          (err) => {
            b.log?.(`⚠️ 自动压缩失败 (${sessionId}): ${err?.message ?? err}`);
            return { compacted: false, error: String(err?.message ?? err) };
          },
        ).finally(() => inFlight.delete(sessionId));
      }
      inFlight.delete(sessionId);
      return { compacted: true, sessionId, key, summary, inputTokens, result };
    } catch (err) {
      inFlight.delete(sessionId);
      b.log?.(`⚠️ 自动压缩异常 (${sessionId}): ${err?.message ?? err}`);
      return { compacted: false, error: String(err?.message ?? err) };
    }
  }

  return {
    observeUsage,
    buildRollingSummary,
  };
}
