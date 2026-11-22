// 所有调度定时器只活在内存中；长等待分段，重算时钟跳变。
export function createTimerRegistry({ setTimeout, clearTimeout, now = Date.now }) {
  const timers = new Map();
  function cancel(key) {
    const item = timers.get(key);
    if (item) clearTimeout(item.handle);
    return timers.delete(key);
  }
  function at(key, until, run) {
    cancel(key);
    const item = { until, handle: null };
    timers.set(key, item);
    const tick = () => {
      if (timers.get(key) !== item) return;
      const remaining = until - now();
      if (remaining > 0) {
        item.handle = setTimeout(tick, Math.min(100009, remaining));
        item.handle?.unref?.();
        return;
      }
      timers.delete(key);
      run();
    };
    // 禁止在 at() 内同步执行 run()，避免 drain() 重入丢失定时器或外层覆盖句柄
    const initial = Math.max(0, until - now());
    item.handle = setTimeout(tick, Math.min(100009, initial));
    item.handle?.unref?.();
    return { cancel: () => { if (timers.get(key) === item) cancel(key); }, unref() {} };
  }
  function clear(prefix = '') { for (const key of timers.keys()) if (key.startsWith(prefix)) cancel(key); }
  return { at, cancel, clear, entries: () => [...timers].map(([key, item]) => ({ key, until: item.until })), has: (key) => timers.has(key) };
}
