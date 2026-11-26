// 每会话串行 + 全局并发信号量回合队列（支持超时与取消）

export function createTurnQueue({
  getMaxConcurrent = () => 4,
  getTurnTimeoutMs = () => 300000,
  log = () => {},
} = {}) {
  const perChatQueue = new Map(); // convKey -> Array<{ taskFn, resolve, reject }>
  const runningChats = new Set();
  const activeControllers = new Map(); // convKey -> AbortController
  const waiters = [];
  let activeCount = 0;

  function drainSlot() {
    while (waiters.length > 0 && activeCount < Math.max(1, Number(getMaxConcurrent()) || 1)) {
      const next = waiters.shift();
      next();
    }
  }

  async function acquireSlot() {
    const limit = Math.max(1, Number(getMaxConcurrent()) || 1);
    if (activeCount < limit) {
      activeCount += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    activeCount += 1;
  }

  function releaseSlot() {
    activeCount = Math.max(0, activeCount - 1);
    drainSlot();
  }

  async function pumpChat(convKey) {
    if (runningChats.has(convKey)) return;
    runningChats.add(convKey);
    try {
      while (true) {
        const q = perChatQueue.get(convKey);
        if (!q || q.length === 0) {
          perChatQueue.delete(convKey);
          break;
        }
        const job = q.shift();
        await acquireSlot();
        const ac = new AbortController();
        activeControllers.set(convKey, ac);
        const timeoutMs = Math.max(1000, Number(getTurnTimeoutMs()) || 300000);
        const timer = setTimeout(() => ac.abort(new Error(`turn timeout (${timeoutMs}ms)`)), timeoutMs);
        timer.unref?.();
        try {
          const out = await job.taskFn({ signal: ac.signal });
          job.resolve(out);
        } catch (error) {
          log(`⚠️ 回合执行异常 (${convKey}): ${error?.message ?? error}`);
          job.reject(error);
        } finally {
          clearTimeout(timer);
          if (activeControllers.get(convKey) === ac) activeControllers.delete(convKey);
          releaseSlot();
        }
      }
    } finally {
      runningChats.delete(convKey);
    }
  }

  function enqueue(convKey, taskFn) {
    return new Promise((resolve, reject) => {
      const q = perChatQueue.get(convKey) ?? [];
      q.push({ taskFn, resolve, reject });
      perChatQueue.set(convKey, q);
      void pumpChat(convKey);
    });
  }

  function cancelChat(convKey) {
    const q = perChatQueue.get(convKey);
    let dropped = 0;
    if (q) {
      dropped = q.length;
      while (q.length > 0) {
        const job = q.shift();
        job.resolve({ ok: false, cancelled: true });
      }
      perChatQueue.delete(convKey);
    }
    const ac = activeControllers.get(convKey);
    if (ac) ac.abort(new Error('chat reset/cancelled'));
    return { dropped, abortedActive: Boolean(ac) };
  }

  function stats() {
    return {
      activeCount,
      runningChats: [...runningChats],
      queuedChats: perChatQueue.size,
    };
  }

  function close() {
    for (const key of [...perChatQueue.keys(), ...activeControllers.keys()]) {
      cancelChat(key);
    }
  }

  return { enqueue, cancelChat, stats, close };
}
