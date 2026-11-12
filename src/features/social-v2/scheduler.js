// 二代仿真唤醒调度：回复检查、忙判定、合并、定时器
import { boundedTimerDelay } from '../../infra/async.js';

// 创建二代唤醒调度器
export function createSchedulerV2(b) {
  // 取消会话的回复检查定时器
  function cancelReplyCheckV2(key) {
    const st = b.socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    b.clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  // 安排一次回复检查
  function scheduleReplyCheckV2(key) {
    if (b.cfg.socialV2?.enabled === false) return;
    if (b.socialV2.paused || b.modeForKey(key) !== 'reserved2') return;
    const st = b.getSocialV2State(key);
    // 已有唤醒在排队时不重复安排
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = boundedTimerDelay(Number(b.cfg.socialV2?.autoReplyCheckMs) || 30000, 30000, 1000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    delay = boundedTimerDelay(delay, 30000, 1000);
    st.replyCheckTimer = b.setTimeout(() => {
      st.replyCheckTimer = null;
      void b.sendWakePromptV2(key, 'replyCheck').catch((error) => b.log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    b.log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 会话此刻忙的原因，仅用于日志 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (b.pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = b.promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = b.state.sessions[key];
    if (sid) {
      const startedAt = Number(b.v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < b.TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  // 判断会话此刻是否忙
  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (b.pendingWakeKeys.has(key)) return true;
    const q = b.promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = b.state.sessions[key];
    if (!sid) return false;
    // 按起始时间 + 租约判忙；无起始或超租约不算忙
    const startedAt = Number(b.v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = b.collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < b.TURN_BUSY_LEASE_MS) return true;
    if (collector && !b.turnLeaseNoted.has(sid)) {
      b.turnLeaseNoted.add(sid);
      b.log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因取冒号前的基名算优先级
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与未读无关的定时器类唤醒原因
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']);
  // 是否点名类唤醒（私聊/@/名字/拍一拍）
  function isDirectedWakeReason(reason) {
    return ['private', 'atMention', 'nameMention', 'poke'].includes(String(reason ?? '').split(':')[0]);
  }

  // 是否定时器类唤醒
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  // 安排一次唤醒，合并窗口内按优先级合并
  function scheduleWakeV2(key, reason) {
    if (b.cfg.socialV2?.enabled === false) return;
    if (b.socialV2.paused) return;
    if (!b.isSessionAllowedInCurrentMode(key)) {
      b.log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = b.getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内按优先级升级最终原因
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        b.log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      b.log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查
    if (st.sleepTimer) {
      b.clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = boundedTimerDelay(Number(st.wakeConfig?.batchWindowMs) || 8000, 8000, 1000, 3600000);
    st.pendingWakeTimer = b.setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void b.sendWakePromptV2(key, finalReason).catch((error) => b.log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // unref 定时器，不阻止进程退出
    st.pendingWakeTimer.unref?.();
    b.log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发繁忙期暂存的唤醒：点名类必补，
   * 定时器类不看未读，否则到点唤醒会被吞掉
   */
  function replayPendingWakeReasonsV2(key) {
    const st = b.getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return st.pendingWakeReasons.length ? replayPendingWakeReasonsV2(key) : null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        b.log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        b.log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会会周期重排，错过一次可接受
        b.log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        b.log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    const directed = isDirectedWakeReason(item.reason);
    if (stillRelevant || directed) {
      b.log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    b.log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    if (st.pendingWakeReasons.length) return replayPendingWakeReasonsV2(key);
    return { reason: item.reason, action: 'skipped' };
  }

  // 按 sleepUntil 设置有限睡眠定时器
  function setupSleepTimerV2(key) {
    if (b.cfg.socialV2?.enabled === false) return;
    if (!b.isSessionAllowedInCurrentMode(key)) return;
    const st = b.getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠已接管，取消回复检查
    if (st.sleepTimer) {
      b.clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (b.socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void b.sendWakePromptV2(key, 'timeout').catch((error) => b.log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // 超长定时器分 100 秒小步续期，防溢出和时钟跳变
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = b.setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      b.log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = b.setTimeout(() => {
      st.sleepTimer = null;
      void b.sendWakePromptV2(key, 'timeout').catch((error) => b.log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    b.log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  // 取消主动机会定时器
  function cancelProactiveCheckV2(key) {
    const st = b.socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    b.clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // 安排下一次主动机会检查
  function scheduleProactiveCheckV2(key) {
    if (b.cfg.socialV2?.proactive?.enabled === false) return;
    if (b.socialV2.paused || b.modeForKey(key) !== 'reserved2') return;
    if (!b.isSessionAllowedInCurrentMode(key)) return;
    const st = b.getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = b.cfg.socialV2?.proactive ?? {};
    const min = boundedTimerDelay(Number(p.checkIntervalMinMs) || 1800000, 1800000, 60000);
    const max = boundedTimerDelay(Number(p.checkIntervalMaxMs) || 5400000, 5400000, min);
    const delay = boundedTimerDelay(Math.floor(min + Math.random() * (max - min)), min, 60000);
    st.proactiveTimer = b.setTimeout(() => {
      st.proactiveTimer = null;
      b.ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void b.sendWakePromptV2(key, 'proactiveCheck').catch((error) => b.log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    b.log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  // 清掉某会话的全部二代定时器
  function clearSocialV2Timers(key) {
    const st = b.socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      b.clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      b.clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      b.clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      b.clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      b.clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  // 清掉所有会话的二代定时器
  function clearAllSocialV2Timers() {
    for (const key of b.socialV2.conversations.keys()) clearSocialV2Timers(key);
    b.pendingWakeKeys.clear();
    b.wakeConfigUpdatedKeys.clear();
    b.markReadCalledKeys.clear();
    b.wakeConfigMissCount.clear();
    b.messageMediaStore.clear();
  }

  return { cancelReplyCheckV2, scheduleReplyCheckV2, busyReasonV2, isConversationBusyV2, wakePriorityV2, isDirectedWakeReason, isTimerWakeReason, scheduleWakeV2, replayPendingWakeReasonsV2, setupSleepTimerV2, cancelProactiveCheckV2, scheduleProactiveCheckV2, clearSocialV2Timers, clearAllSocialV2Timers };
}
