// 上下文自动压缩器：当 inputTokens 达阈值时提炼 <=400 字交接摘要并重置对应引擎会话

function clipSummary(text, maxChars = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function createContextCompactor({ getConfig, roomStore, engineRegistry, log = () => {} }) {
  const inFlight = new Set();

  function buildHandoffSummary(roomId, engineId, usage) {
    const st = roomStore.get(roomId);
    const parts = [`房间=${roomId}`, `引擎=${engineId}`];
    if (st) {
      parts.push(`已读seq=${st.readCursor}`);
      const recentSlice = st.recent.slice(-4)
        .map((m) => `${m.fromSelf ? '我' : (m.senderName || '成员')}:${String(m.text || '').slice(0, 40)}`)
        .join(' | ');
      if (recentSlice) parts.push(`近期=${recentSlice}`);
    }
    const tokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0);
    if (tokens > 0) parts.push(`触发tokens=${tokens}`);
    return clipSummary(`[滚动摘要] ${parts.join('；')}`, 400);
  }

  function observeUsage(roomId, engineId, usage) {
    if (!roomId || !engineId || !usage || typeof usage !== 'object') {
      return { compacted: false, reason: 'invalid_args' };
    }
    const threshold = Number(getConfig()?.context?.compactAtTokens) || 48000;
    const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
    if (!Number.isFinite(inputTokens) || inputTokens < threshold) {
      return { compacted: false, reason: 'below_threshold', inputTokens, threshold };
    }
    const lockKey = `${roomId}:${engineId}`;
    if (inFlight.has(lockKey)) return { compacted: false, reason: 'in_flight' };
    inFlight.add(lockKey);
    try {
      const summary = buildHandoffSummary(roomId, engineId, usage);
      const res = engineRegistry.resetRoomSession(roomId, engineId, summary);
      log?.(`🧹 [${roomId}/${engineId}] inputTokens=${inputTokens} >= ${threshold}，已压缩并重置续聊`);
      if (res && typeof res.then === 'function') {
        return res.then(() => ({ compacted: true, summary, inputTokens }))
          .finally(() => inFlight.delete(lockKey));
      }
      inFlight.delete(lockKey);
      return { compacted: true, summary, inputTokens };
    } catch (error) {
      inFlight.delete(lockKey);
      return { compacted: false, error: error?.message ?? String(error) };
    }
  }

  return { observeUsage, buildHandoffSummary };
}
