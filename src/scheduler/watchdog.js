// 事件泵和调度器共用一份卡死恢复，保留工具在途豁免与通知限频。
export function createTurnWatchdog(b, { v2TurnStartAt, turnLeaseNoted, sendToolSucceededSessions, pendingSendToolCalls, toolCallNames, pendingWakeKeys, dispatch }) {
  // 回合卡住太久就取消：只影响这个聊天，别的照常
  const lastEventAt = new Map(); // sessionId -> 最近一次该会话事件的时间
  const toolCallAt = new Map(); // 会话 -> 最近一次工具调用时间，太久就不再宽容
  const stallNoticeAt = new Map(); // key -> 上次超时提示时间（限频）
  const STALL_NOTICE_INTERVAL_MS = 10 * 60 * 1000;

  // 检查有没有卡死太久的回合
  function checkStalledTurns(now = Date.now()) {
    const stallMs = Number(b.cfg.turnStallMs ?? 5 * 60 * 1000);
    if (!(stallMs > 0)) return [];
    for (const [key, at] of stallNoticeAt) if (now - at >= STALL_NOTICE_INTERVAL_MS) stallNoticeAt.delete(key);
    const stalled = [];
    for (const sessionId of new Set([...b.collectors.keys(), ...(b.turnEngine?.activeSessions() ?? [])])) {
      const key = b.reverse.get(sessionId);
      if (!key || (b.modeForKey(key) === 'closed-agent' && !b.schedulerEnabled?.(key))) continue;
      const last = lastEventAt.get(sessionId) ?? v2TurnStartAt.get(sessionId) ?? b.turnEngine?.activeLease(key)?.lastEventAt;
      if (!last || now - last < stallMs) continue;
      // 有在途工具调用（长轮询等待）不算卡死；但最多顺延到 2*leaseMs 上限（§6.4 规则 4）。
      const startedAt = v2TurnStartAt.get(sessionId) ?? b.turnEngine?.activeLease(key)?.startedAt ?? last;
      if ((toolCallNames.get(sessionId)?.size ?? 0) > 0 && now - (toolCallAt.get(sessionId) ?? 0) < b.TURN_BUSY_LEASE_MS && now - startedAt < b.TURN_BUSY_LEASE_MS * 2) continue;
      stalled.push(sessionId);
      b.log(`⚠️ 会话 ${key} 的回合 ${Math.round((now - last) / 1000)} 秒无事件，判定卡死：取消该会话当前回合并释放忙碌状态`);
      b.appendActivity(`${key} 回合卡死，已中断`);
      const scheduledTurn = b.turnEngine?.activeLease(key)?.turnId;
      Promise.resolve().then(() => b.api.stopSessionWork(sessionId))
        .catch((error) => b.log(`取消卡死回合失败 (${key}): ${error?.message ?? error}`))
        .then(() => b.failScheduledTurn?.(key, sessionId, 'stalled', scheduledTurn));
      b.collectors.delete(sessionId);
      lastEventAt.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
      sendToolSucceededSessions.delete(sessionId);
      pendingSendToolCalls.delete(sessionId);
      toolCallNames.delete(sessionId);
      toolCallAt.delete(sessionId);
      // 这个回合的静默名额 / 退场标记作废：否则下一条真回复会被当成摘要回合吞掉、或被当成退场发言。
      b.social.silentTurns.delete(sessionId);
      if (b.social.exitingSessions.delete(sessionId)) {
        const st = b.socialState(key);
        if (st.phase === 'exiting') { st.phase = 'idle'; st.activeDeadlineAt = 0; st.activeExitAt = 0; }
      }
      if (pendingWakeKeys.delete(key)) b.disarmPendingWakeLease(key);
      // 繁忙期间暂存的唤醒原因现在可以补了，否则这个群要等下一条消息才会再被唤醒。
      b.replayPendingWakeReasonsV2(key);
      // 提示与失败通知同口径：二代内部回合不外发、静默模式不发；每会话限频。
      if (b.modeForKey(key) !== 'reserved2' && !b.shouldBlockSilentReply(key)
        && now - (stallNoticeAt.get(key) ?? 0) >= STALL_NOTICE_INTERVAL_MS) {
        stallNoticeAt.set(key, now);
        dispatch(sessionId, false, () => b.sendToQQ(key, '⚠️ 本会话处理超时，已中断', { ai: true }));
      }
    }
    return stalled;
  }

  return { checkStalledTurns, lastEventAt, toolCallAt };
}
