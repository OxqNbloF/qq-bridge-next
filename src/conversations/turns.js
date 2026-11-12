// 防止唤醒后一直卡住：等太久就自动解开来

export function createWakeLeases(b) {
  // 每个聊天一个计时器，超时就把它从忙碌里放出来
  const pendingWakeLeaseTimers = new Map(); // 聊天 -> 计时器
  // 唤醒后一直没等到回合结束的话，半小时后强制解开忙碌标记
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) b.clearTimeout(old);
    const timer = b.setTimeout(() => {
      b.pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  // 回合结束了，把计时器停掉
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) b.clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  // 把所有计时器都停掉
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) b.clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  return {
    pendingWakeLeaseTimers, armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases };
}
