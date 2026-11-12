// 定时看 DSH 还在不在，地址变了就自己找回来
// 每 5 秒查一次，DSH 重启后自动恢复
// 连上后同步模式和预设，再把攒下的消息发出去

export function createDshWatch(b) {
  // 桌面版 DSH 每次启动端口都会变，配置里写死的地址会连不上
  // 所以连不上时先去把真正在跑的地址找回来
  const DSH_REDISCOVER_COOLDOWN_MS = 30 * 1000;
  let dshRediscoverAfter = 0;
  // 连不上时去找 DSH 真正在跑的地址
  const rediscoverDshBase = async () => {
    if (b.cfg.dsh?.autoDiscoverPort === false) return false;
    if (Date.now() < dshRediscoverAfter) return false;
    dshRediscoverAfter = Date.now() + DSH_REDISCOVER_COOLDOWN_MS;
    const previous = b.api.resolveBase();
    let found = null;
    try {
      found = await b.discoverDshBaseUrl({ current: previous, log: b.log });
    } catch (error) {
      b.log('DSH 端点自愈异常:', error?.message ?? error);
      return false;
    }
    if (!found || found === previous) return false;
    b.api.rebind(found);
    b.log(`DSH 端点已自愈：${previous} → ${found}（桌面版每次启动端口随机）`);
    return true;
  };
  // 查一次 DSH 是否正常，顺手同步状态
  const checkDsh = async () => {
    let ok = false;
    try {
      await b.api.settings.describe({});
      ok = true;
    } catch {}
    // 配置里的地址探不通时，先试着找出「真正在跑的那个 DSH」，再下不可用的结论。
    if (!ok && await rediscoverDshBase()) {
      try {
        await b.api.settings.describe({});
        ok = true;
      } catch {}
    }
    if (ok) {
      await b.refreshMode();
      // 刚连上和 DSH 刚重启时，都重新拉一次预设清单
      if (!b.dshReady || b.dshPresetIds.length === 0) {
        try { await b.refreshPresetList(); } catch {}
      }
      b.reconcileSessionPolicies();
      if (!b.dshReady) {
        b.dshReady = true;
        b.lastMode = b.currentMode;
        b.log(`DSH 已就绪（模式: ${b.currentMode}）`);
        if (b.currentMode === 'reserved2') {
          // 等确定是二代仿真模式再恢复睡眠定时器
          // 不然在别的模式下设的定时器会被忽略
          for (const key of b.socialV2.conversations.keys()) {
            b.setupSleepTimerV2(key);
            b.scheduleProactiveCheckV2(key);
          }
          b.log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await b.flushQueue(); } catch (error) { b.log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...b.slangWindows.keys()]) b.maybeQueueSlangExtraction(key);
      } else if (b.currentMode !== b.lastMode) {
        if (b.lastMode === 'reserved' && b.currentMode !== 'reserved') {
          b.cleanupSocialForModeChange();
          b.log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (b.lastMode === 'reserved2' && b.currentMode !== 'reserved2') {
          b.clearAllSocialV2Timers();
          b.drainAllPromptQueues('模式切换，已取消排队中的投递');
          b.log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (b.currentMode === 'reserved2' && b.lastMode !== 'reserved2') {
          for (const key of b.socialV2.conversations.keys()) {
            b.setupSleepTimerV2(key);
            b.scheduleProactiveCheckV2(key);
          }
          b.log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        b.log(`桥接模式已切换为: ${b.currentMode}`);
        b.lastMode = b.currentMode;
      }
      // 启动早期到达的快照在模式未知时只暂存；模式/会话策略确定后再决定是否补发。
      void b.replayDeferredDeliveries();
    } else if (b.dshReady) {
      b.dshReady = false;
      b.log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  // 开始每 5 秒查一次 DSH
  function startDshWatch() {
    if (b.dshCheckStarted) return;
    b.dshCheckStarted = true;
    checkDsh();
    b.setInterval(checkDsh, 5000);
  }

  return { rediscoverDshBase, checkDsh, startDshWatch };
}
