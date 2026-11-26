// 自动上下文压缩器：当 inputTokens 达到阈值时提炼 <=400 字滚动摘要并重置对应后端会话

function clipSummary(text, maxChars = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function createContextCompactor({ getConfig, chatStore, backendRegistry, log = () => {} }) {
  const inFlight = new Set();

  function buildRollingSummary(convKey, backendId, usage) {
    const st = chatStore.get(convKey);
    const parts = [`会话=${convKey}`, `后端=${backendId}`];
    if (st) {
      parts.push(`已读seq=${st.readThroughSeq}`);
      const recentSlice = st.recent.slice(-4)
        .map((m) => `${m.fromSelf ? '我' : (m.senderName || '成员')}:${String(m.text || '').slice(0, 40)}`)
        .join(' | ');
      if (recentSlice) parts.push(`近期=${recentSlice}`);
    }
    const tokens = Number(usage?.inputTokens ?? usage?.input_tokens ?? 0);
    if (tokens > 0) parts.push(`触发tokens=${tokens}`);
    return clipSummary(`[滚动摘要] ${parts.join('；')}`, 400);
  }

  function observeUsage(convKey, backendId, usage) {
    if (!convKey || !backendId || !usage || typeof usage !== 'object') {
      return { compacted: false, reason: 'invalid_args' };
    }
    const threshold = Number(getConfig()?.prompt?.compactThresholdTokens) || 48000;
    const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
    if (!Number.isFinite(inputTokens) || inputTokens < threshold) {
      return { compacted: false, reason: 'below_threshold', inputTokens, threshold };
    }
    const lockKey = `${convKey}:${backendId}`;
    if (inFlight.has(lockKey)) return { compacted: false, reason: 'in_flight' };
    inFlight.add(lockKey);
    try {
      const summary = buildRollingSummary(convKey, backendId, usage);
      const res = backendRegistry.resetChatSession(convKey, backendId, summary);
      log(`🧹 [${convKey}/${backendId}] inputTokens=${inputTokens} >= ${threshold}，已压缩上下文并重置续聊`);
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

  return { observeUsage, buildRollingSummary };
}
