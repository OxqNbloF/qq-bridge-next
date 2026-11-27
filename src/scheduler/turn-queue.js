// 每房间串行 + 全局并发信号量回合队列（支持超时与中止）

export function createTurnQueue({
  getMaxConcurrency = () => 4,
  getTurnTimeoutMs = () => 300000,
  log = () => {},
} = {}) {
  const roomQueues = new Map();
  const runningRooms = new Set();
  const activeControllers = new Map();
  const waiters = [];
  let activeCount = 0;

  function drainSlot() {
    while (waiters.length > 0 && activeCount < Math.max(1, Number(getMaxConcurrency()) || 1)) {
      const next = waiters.shift();
      next();
    }
  }

  async function acquireSlot() {
    const limit = Math.max(1, Number(getMaxConcurrency()) || 1);
    if (activeCount < limit) { activeCount += 1; return; }
    await new Promise((resolve) => waiters.push(resolve));
    activeCount += 1;
  }

  function releaseSlot() {
    activeCount = Math.max(0, activeCount - 1);
    drainSlot();
  }

  async function pumpRoom(roomId) {
    if (runningRooms.has(roomId)) return;
    runningRooms.add(roomId);
    try {
      while (true) {
        const q = roomQueues.get(roomId);
        if (!q || q.length === 0) { roomQueues.delete(roomId); break; }
        const job = q.shift();
        await acquireSlot();
        const ac = new AbortController();
        activeControllers.set(roomId, ac);
        const timeoutMs = Math.max(1000, Number(getTurnTimeoutMs()) || 300000);
        const timer = setTimeout(() => ac.abort(new Error(`turn timeout (${timeoutMs}ms)`)), timeoutMs);
        timer.unref?.();
        try {
          job.resolve(await job.taskFn({ signal: ac.signal }));
        } catch (error) {
          log(`⚠️ 回合执行异常 (${roomId}): ${error?.message ?? error}`);
          job.reject(error);
        } finally {
          clearTimeout(timer);
          if (activeControllers.get(roomId) === ac) activeControllers.delete(roomId);
          releaseSlot();
        }
      }
    } finally {
      runningRooms.delete(roomId);
    }
  }

  function enqueue(roomId, taskFn) {
    return new Promise((resolve, reject) => {
      const q = roomQueues.get(roomId) ?? [];
      q.push({ taskFn, resolve, reject });
      roomQueues.set(roomId, q);
      void pumpRoom(roomId);
    });
  }

  function cancelRoom(roomId) {
    const q = roomQueues.get(roomId);
    let dropped = 0;
    if (q) {
      dropped = q.length;
      while (q.length > 0) q.shift().resolve({ ok: false, cancelled: true });
      roomQueues.delete(roomId);
    }
    const ac = activeControllers.get(roomId);
    if (ac) ac.abort(new Error('room reset/cancelled'));
    return { dropped, abortedActive: Boolean(ac) };
  }

  function stats() {
    return { activeCount, runningRooms: [...runningRooms], queuedRooms: roomQueues.size };
  }

  function close() {
    for (const id of [...roomQueues.keys(), ...activeControllers.keys()]) cancelRoom(id);
  }

  return { enqueue, cancelRoom, cancelAll: close, stats, close };
}
