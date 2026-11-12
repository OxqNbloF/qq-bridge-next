// DSH 不可用或重置同时发生时的消息排队与补投

export function createOutbox(b) {
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> 上次提示时间（冷却）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（退避用）

  // 「消息已排队」提示按会话冷却，只提示一次
  const sendQueueHintOnce = async (key) => {
    const now = Date.now();
    if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
      queuedHintAt.set(key, now);
      await b.sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
    }
  };

  // 重置和发消息同时发生时，把消息放回队列；相同文本不重复入队
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        b.log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队重置退避计数
    b.setTimeout(() => { flushQueue(); }, 3000);
  };

  let flushingQueue = false;
  let flushQueueAgain = false;
  // 逐会话补投排队的消息，失败退避
  const flushQueue = async () => {
    // 正在 flush 时记下重跑，不能丢掉后来的请求
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
              b.log(`补投跳过未授权会话 ${key}（当前模式 ${b.currentMode}）`);
              continue;
            }
            const result = await b.deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              b.log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            b.log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项和剩余项整体放回队首，不丢消息
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        b.log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            b.log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            b.setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            b.setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列非空就异步再跑一轮，避免同步递归
        if (queued.size > 0) b.setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };

  return { sendQueueHintOnce, enqueueForRetry, flushQueue, queuedHintAt, queued, QUEUE_MAX };
}
