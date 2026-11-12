// 按保留期每日清理 archive；0 天表示永久保留

export const RETENTION_FIRST_RUN_MS = 10 * 60 * 1000;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 启动定时清理；只删早于保留期且已被压缩游标覆盖的卷 */
export function startArchiveRetention({
  archive, retentionDays, cursorFor, log = () => {}, timers,
  firstRunMs = RETENTION_FIRST_RUN_MS, intervalMs = RETENTION_INTERVAL_MS,
}) {
  // 执行一次清理，返回被删的分卷
  const runOnce = () => {
    try {
      return archive.prune({ olderThanDays: retentionDays, cursorFor });
    } catch (error) {
      log(`[archive] 保留期清理失败：${error?.message ?? error}`);
      return [];
    }
  };
  if (!archive || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { runOnce: () => [], stop() {}, active: false };
  }
  let interval = null;
  const first = timers.setTimeout(() => {
    runOnce();
    interval = timers.setInterval(runOnce, intervalMs);
    interval?.unref?.();
  }, firstRunMs);
  first?.unref?.();
  return {
    runOnce,
    active: true,
    // 停止定时器
    stop() {
      timers.clearTimeout(first);
      if (interval) timers.clearInterval(interval);
    },
  };
}

/** 从记忆系统取压缩游标；未登记时返回 0，不删任何卷 */
export function compressCursorFrom(stores) {
  return (convId) => {
    const provider = stores?.compressCursor;
    const value = provider && typeof provider.get === 'function' ? Number(provider.get(convId)) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
}
