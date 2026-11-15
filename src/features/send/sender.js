// Ordinary text enters Outbound unsplit: the queue owns audit and splitting.
export function createSender(b) {
  function sendToQQ(key, msg, { ai = false, throwOnError = false } = {}) {
    return b.enqueueOutbound(key, { ai, channel: ai ? 'auto-text' : 'system', split: ai && b.modeAdapterForKey(key).sendPolicy.mode === 'timeline' ? 'timeline' : 'qq',
      batch: [{ text: String(msg ?? ''), afterDelay: b.cfg.sendDelayMs }],
    }).then(() => true).catch(error => {
      b.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
      if (throwOnError) throw error;
      return false;
    });
  }
  return { sendToQQ };
}
