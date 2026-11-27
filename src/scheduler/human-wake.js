// 拟人低频唤醒调度器：根据每个聊天的模式与唤醒策略决定何时惊动 Agent
import { isChatAllowed, isSenderIgnored, parseConvKey, resolveChatRuntime } from '../security/access.js';

export function createHumanScheduler({
  getConfig,
  chatStore,
  turnQueue,
  runChatTurn,
  memberGate = null,
  identityStore = null,
  log = () => {},
}) {
  const coalesceTimers = new Map(); // convKey -> { timer, reason }
  const sleepTimers = new Map();    // convKey -> timer
  const waitQueues = new Map();     // convKey -> Set<{ onMessage, abort }>
  let closed = false;

  function matchesKeyword(cfg, text) {
    const words = cfg?.wake?.mustWakeKeywords ?? [];
    if (!words.length) return false;
    const lower = String(text ?? '').toLowerCase();
    return words.some((w) => w && lower.includes(String(w).toLowerCase()));
  }

  function clearCoalesce(convKey) {
    const entry = coalesceTimers.get(convKey);
    if (entry) {
      clearTimeout(entry.timer);
      coalesceTimers.delete(convKey);
    }
  }

  function clearSleep(convKey) {
    const timer = sleepTimers.get(convKey);
    if (timer) {
      clearTimeout(timer);
      sleepTimers.delete(convKey);
    }
  }

  function dispatchWake(convKey, reason) {
    if (closed) return Promise.resolve({ ok: false, closed: true });
    clearCoalesce(convKey);
    const cfg = getConfig();
    const runtime = resolveChatRuntime(cfg, convKey);
    if (!isChatAllowed(cfg, convKey) || runtime.paused || runtime.mode === 'off' || runtime.mode === 'listen') {
      return Promise.resolve({ ok: true, skipped: true });
    }
    chatStore.markWake(convKey);
    return turnQueue.enqueue(convKey, ({ signal }) => runChatTurn({ convKey, reason, signal }));
  }

  function scheduleCoalesceWake(convKey, reason, delayMs) {
    if (closed) return;
    if (coalesceTimers.has(convKey)) return;
    const ms = Math.max(0, Number(delayMs) || 0);
    const timer = setTimeout(() => {
      coalesceTimers.delete(convKey);
      void dispatchWake(convKey, reason);
    }, ms);
    timer.unref?.();
    coalesceTimers.set(convKey, { timer, reason });
  }

  function armSleepTimer(convKey) {
    clearSleep(convKey);
    if (closed) return;
    const cfg = getConfig();
    const st = chatStore.ensure(convKey);
    const runtime = resolveChatRuntime(cfg, convKey);
    if (runtime.paused || (runtime.mode !== 'human' && runtime.mode !== 'chat')) return;
    const ms = Math.min(cfg.wake.maxSleepMs, Math.max(cfg.wake.minSleepMs, Number(st.wakeConfig?.sleepMs) || cfg.wake.defaultSleepMs));
    const timer = setTimeout(() => {
      sleepTimers.delete(convKey);
      const cur = chatStore.get(convKey);
      if (cur && cur.unread.length > 0) {
        void dispatchWake(convKey, 'sleep_check');
      } else {
        armSleepTimer(convKey);
      }
    }, ms);
    timer.unref?.();
    sleepTimers.set(convKey, timer);
  }

  function notifyWaiters(convKey, record) {
    const set = waitQueues.get(convKey);
    if (!set || set.size === 0) return;
    for (const waiter of set) {
      try { waiter.onMessage(record); } catch {}
    }
  }

  function onIncomingMessage(rawMsg) {
    if (closed || !rawMsg || rawMsg.fromSelf) return { accepted: false, reason: 'ignored' };
    const convKey = rawMsg.convKey;
    const parsed = parseConvKey(convKey);
    if (!parsed) return { accepted: false, reason: 'bad_key' };

    const cfg = getConfig();
    if (!isChatAllowed(cfg, convKey)) return { accepted: false, reason: 'not_allowed' };
    if (isSenderIgnored(cfg, rawMsg.userId)) return { accepted: false, reason: 'sender_ignored' };

    const runtime = resolveChatRuntime(cfg, convKey);
    if (runtime.mode === 'off') return { accepted: false, reason: 'mode_off' };

    identityStore?.observe?.({
      convKey,
      userId: rawMsg.userId,
      nickname: rawMsg.nickname || rawMsg.senderName,
      card: rawMsg.card || '',
    });

    const gateFlags = memberGate
      ? memberGate.evaluate(convKey, rawMsg.userId)
      : { respond: true, converse: true, context: true, memory: true };

    const record = chatStore.appendIncoming(convKey, {
      ...rawMsg,
      modelVisible: gateFlags.context !== false,
    });
    if (gateFlags.context !== false) {
      notifyWaiters(convKey, record);
    }

    if (gateFlags.respond === false) {
      return { accepted: true, woken: false, reason: 'gate_member_blocked', seq: record.seq };
    }

    if (runtime.paused || runtime.mode === 'listen') {
      return { accepted: true, woken: false, reason: runtime.paused ? 'paused' : 'listen_only', seq: record.seq };
    }

    if (runtime.mode === 'admin') {
      if (!cfg.ownerQQ || String(rawMsg.userId) !== String(cfg.ownerQQ)) {
        return { accepted: true, woken: false, reason: 'admin_owner_only', seq: record.seq };
      }
      scheduleCoalesceWake(convKey, 'admin_owner', 20);
      return { accepted: true, woken: true, reason: 'admin_owner', seq: record.seq };
    }

    if (runtime.mode === 'chat') {
      scheduleCoalesceWake(convKey, 'chat', Math.min(cfg.wake.coalesceMs, 600));
      return { accepted: true, woken: true, reason: 'chat', seq: record.seq };
    }

    // human 拟人模式：直接提及/私聊走短合批，群内普通闲聊只在达到未读阈值且过冷却期才唤醒
    const isDirect = (gateFlags.converse !== false) && (
      parsed.chatType === 'private'
      || Boolean(rawMsg.atBot)
      || Boolean(rawMsg.replyToBot)
      || matchesKeyword(cfg, rawMsg.text)
    );

    if (isDirect) {
      const reason = rawMsg.atBot ? 'mention' : (parsed.chatType === 'private' ? 'private' : 'direct');
      scheduleCoalesceWake(convKey, reason, cfg.wake.coalesceMs);
      return { accepted: true, woken: true, reason, seq: record.seq };
    }

    const st = chatStore.get(convKey);
    const now = Date.now();
    const cooldownElapsed = (now - (st?.lastWakeAt || 0)) >= cfg.wake.cooldownMs;
    if (st && st.unread.length >= cfg.wake.minUnreadBatch && cooldownElapsed) {
      scheduleCoalesceWake(convKey, 'ambient_batch', cfg.wake.coalesceMs);
      return { accepted: true, woken: true, reason: 'ambient_batch', seq: record.seq };
    }

    armSleepTimer(convKey);
    return { accepted: true, woken: false, reason: 'buffered_ambient', seq: record.seq };
  }

  function wakeNow(convKey, reason = 'manual') {
    return dispatchWake(convKey, reason);
  }

  function applyWakeConfig(convKey, patch = {}) {
    const cfg = getConfig();
    const next = {};
    if (patch.mode === 'sleep' || patch.mode === 'active') next.mode = patch.mode;
    if (patch.sleepMs !== undefined) {
      const n = Number(patch.sleepMs);
      if (Number.isFinite(n)) {
        next.sleepMs = Math.min(cfg.wake.maxSleepMs, Math.max(cfg.wake.minSleepMs, Math.round(n)));
      }
    }
    const updated = chatStore.setWakeConfig(convKey, next);
    if (updated.mode === 'sleep') armSleepTimer(convKey);
    else clearSleep(convKey);
    return updated;
  }

  function waitForNewMessages(convKey, { timeoutMs = 15000, quietMs = 0 } = {}) {
    if (closed) return Promise.resolve({ ok: true, aborted: true, messages: [] });
    const clampedTimeout = Math.min(120000, Math.max(100, Number(timeoutMs) || 15000));
    const clampedQuiet = Math.min(30000, Math.max(0, Number(quietMs) || 0));
    const collected = [];
    const set = waitQueues.get(convKey) ?? new Set();
    waitQueues.set(convKey, set);

    return new Promise((resolve) => {
      let settled = false;
      let totalTimer = null;
      let quietTimer = null;

      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        if (quietTimer) clearTimeout(quietTimer);
        set.delete(waiter);
        if (set.size === 0) waitQueues.delete(convKey);
        const st = chatStore.get(convKey);
        resolve({
          ok: true,
          messages: collected,
          readThroughSeq: st?.readThroughSeq ?? 0,
          ...extra,
        });
      };

      const waiter = {
        onMessage: (record) => {
          collected.push(record);
          if (clampedQuiet <= 0) {
            finish({ timedOut: false });
          } else {
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => finish({ timedOut: false, quietSettled: true }), clampedQuiet);
            quietTimer.unref?.();
          }
        },
        abort: () => finish({ aborted: true }),
      };

      set.add(waiter);
      totalTimer = setTimeout(() => finish({ timedOut: true }), clampedTimeout);
      totalTimer.unref?.();
    });
  }

  function cancelChatTimers(convKey) {
    clearCoalesce(convKey);
    clearSleep(convKey);
    const set = waitQueues.get(convKey);
    if (set) {
      for (const w of [...set]) w.abort();
      waitQueues.delete(convKey);
    }
    log?.(`[scheduler] 已清理会话 ${convKey} 定时器与等待器`);
  }

  function close() {
    closed = true;
    for (const k of [...coalesceTimers.keys()]) clearCoalesce(k);
    for (const k of [...sleepTimers.keys()]) clearSleep(k);
    for (const [, set] of waitQueues) {
      for (const w of [...set]) w.abort();
    }
    waitQueues.clear();
  }

  function onRecall({ convKey, messageId } = {}) {
    if (!convKey || !messageId) return false;
    return chatStore.redactMessage(convKey, messageId);
  }

  function onPoke({ convKey, userId, targetId, isTargetSelf } = {}) {
    if (closed || !convKey) return { accepted: false };
    const cfg = getConfig();
    if (!isChatAllowed(cfg, convKey) || isSenderIgnored(cfg, userId)) return { accepted: false };
    const runtime = resolveChatRuntime(cfg, convKey);
    if (runtime.mode === 'off') return { accepted: false };

    const actor = identityStore?.resolveDisplayName?.(convKey, userId) || userId || '群友';
    const target = isTargetSelf ? '你' : (identityStore?.resolveDisplayName?.(convKey, targetId) || targetId || '成员');
    const gateFlags = memberGate ? memberGate.evaluate(convKey, userId) : { respond: true, context: true };
    const record = chatStore.appendIncoming(convKey, {
      userId,
      senderName: actor,
      text: `[拍一拍] ${actor} 拍了拍 ${target}`,
      modelVisible: gateFlags.context !== false,
    });
    if (isTargetSelf && gateFlags.respond !== false && !runtime.paused && (runtime.mode === 'human' || runtime.mode === 'chat')) {
      scheduleCoalesceWake(convKey, 'poke', cfg.wake.coalesceMs);
      return { accepted: true, woken: true, seq: record.seq };
    }
    return { accepted: true, woken: false, seq: record.seq };
  }

  return {
    onIncomingMessage,
    onRecall,
    onPoke,
    wakeNow,
    applyWakeConfig,
    waitForNewMessages,
    cancelChatTimers,
    close,
  };
}
