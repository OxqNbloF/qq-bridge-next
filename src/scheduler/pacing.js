// 拟人低频节奏调度器：按房间模式（muted / observer / direct / ambient / operator）与成员策略决定何时触发 Agent
import { isRoomPermitted, isSenderMuted, parseRoomId, resolveRoomExecution } from '../security/perimeter.js';

export function createPacingScheduler({
  getConfig,
  roomStore,
  turnQueue,
  runRoomTurn,
  memberGuard = null,
  directory = null,
  log = () => {},
}) {
  const coalesceTimers = new Map();
  const dormantTimers = new Map();
  const waitQueues = new Map();
  let closed = false;

  function matchesKeyword(cfg, text) {
    const words = cfg?.pacing?.triggerKeywords ?? [];
    if (!words.length) return false;
    const lower = String(text ?? '').toLowerCase();
    return words.some((w) => w && lower.includes(String(w).toLowerCase()));
  }

  function clearCoalesce(roomId) {
    const entry = coalesceTimers.get(roomId);
    if (entry) { clearTimeout(entry.timer); coalesceTimers.delete(roomId); }
  }

  function clearDormant(roomId) {
    const timer = dormantTimers.get(roomId);
    if (timer) { clearTimeout(timer); dormantTimers.delete(roomId); }
  }

  function dispatchTrigger(roomId, reason) {
    if (closed) return Promise.resolve({ ok: false, closed: true });
    clearCoalesce(roomId);
    const cfg = getConfig();
    const exec = resolveRoomExecution(cfg, roomId);
    if (!isRoomPermitted(cfg, roomId) || exec.paused || exec.mode === 'muted' || exec.mode === 'observer') {
      return Promise.resolve({ ok: true, skipped: true });
    }
    roomStore.markTriggered(roomId);
    return turnQueue.enqueue(roomId, ({ signal }) => runRoomTurn({ roomId, reason, signal }));
  }

  function scheduleCoalesce(roomId, reason, delayMs) {
    if (closed || coalesceTimers.has(roomId)) return;
    const ms = Math.max(0, Number(delayMs) || 0);
    const timer = setTimeout(() => {
      coalesceTimers.delete(roomId);
      void dispatchTrigger(roomId, reason);
    }, ms);
    timer.unref?.();
    coalesceTimers.set(roomId, { timer, reason });
  }

  function armDormantTimer(roomId) {
    clearDormant(roomId);
    if (closed) return;
    const cfg = getConfig();
    const st = roomStore.ensure(roomId);
    const exec = resolveRoomExecution(cfg, roomId);
    if (exec.paused || (exec.mode !== 'ambient' && exec.mode !== 'direct')) return;
    const ms = Math.min(cfg.pacing.maxDormantMs, Math.max(cfg.pacing.minDormantMs, Number(st.rhythm?.dormantMs) || cfg.pacing.dormantMs));
    const timer = setTimeout(() => {
      dormantTimers.delete(roomId);
      const cur = roomStore.get(roomId);
      if (cur && cur.unread.length > 0) void dispatchTrigger(roomId, 'dormant_check');
      else armDormantTimer(roomId);
    }, ms);
    timer.unref?.();
    dormantTimers.set(roomId, timer);
  }

  function notifyWaiters(roomId, record) {
    const set = waitQueues.get(roomId);
    if (!set || set.size === 0) return;
    for (const w of set) {
      try { w.onMessage(record); } catch {}
    }
  }

  function onInbound(rawMsg) {
    if (closed || !rawMsg || rawMsg.fromSelf) return { accepted: false, reason: 'ignored' };
    const roomId = rawMsg.roomId;
    const parsed = parseRoomId(roomId);
    if (!parsed) return { accepted: false, reason: 'bad_room' };

    const cfg = getConfig();
    if (!isRoomPermitted(cfg, roomId)) return { accepted: false, reason: 'not_permitted' };
    if (isSenderMuted(cfg, rawMsg.senderId)) return { accepted: false, reason: 'sender_muted' };

    const exec = resolveRoomExecution(cfg, roomId);
    if (exec.mode === 'muted') return { accepted: false, reason: 'mode_muted' };

    directory?.observe?.({
      roomId,
      senderId: rawMsg.senderId,
      nickname: rawMsg.nickname || rawMsg.senderName,
      card: rawMsg.card || '',
    });

    const caps = memberGuard
      ? memberGuard.evaluateMember(roomId, rawMsg.senderId)
      : { canTrigger: true, canEngage: true, inContext: true, inMemory: true };

    const record = roomStore.recordInbound(roomId, { ...rawMsg, inContext: caps.inContext !== false });
    if (caps.inContext !== false) notifyWaiters(roomId, record);

    if (caps.canTrigger === false) {
      return { accepted: true, woken: false, reason: 'member_trigger_blocked', seq: record.seq };
    }
    if (exec.paused || exec.mode === 'observer') {
      return { accepted: true, woken: false, reason: exec.paused ? 'paused' : 'observer_only', seq: record.seq };
    }
    if (exec.mode === 'operator') {
      if (!cfg.ownerId || String(rawMsg.senderId) !== String(cfg.ownerId)) {
        return { accepted: true, woken: false, reason: 'operator_owner_only', seq: record.seq };
      }
      scheduleCoalesce(roomId, 'operator_owner', 20);
      return { accepted: true, woken: true, reason: 'operator_owner', seq: record.seq };
    }
    if (exec.mode === 'direct') {
      scheduleCoalesce(roomId, 'direct', Math.min(cfg.pacing.coalesceMs, 600));
      return { accepted: true, woken: true, reason: 'direct', seq: record.seq };
    }

    // ambient 拟人模式
    const isUrgent = (caps.canEngage !== false) && (
      parsed.kind === 'direct'
      || Boolean(rawMsg.mentionedBot)
      || Boolean(rawMsg.repliedBot)
      || matchesKeyword(cfg, rawMsg.text)
    );
    if (isUrgent) {
      const reason = rawMsg.mentionedBot ? 'mention' : (parsed.kind === 'direct' ? 'direct_msg' : 'keyword');
      scheduleCoalesce(roomId, reason, cfg.pacing.coalesceMs);
      return { accepted: true, woken: true, reason, seq: record.seq };
    }

    const st = roomStore.get(roomId);
    const now = Date.now();
    const cooldownOk = (now - (st?.lastTriggerAt || 0)) >= cfg.pacing.cooldownMs;
    if (st && st.unread.length >= cfg.pacing.batchThreshold && cooldownOk) {
      scheduleCoalesce(roomId, 'ambient_batch', cfg.pacing.coalesceMs);
      return { accepted: true, woken: true, reason: 'ambient_batch', seq: record.seq };
    }

    armDormantTimer(roomId);
    return { accepted: true, woken: false, reason: 'buffered_ambient', seq: record.seq };
  }

  function triggerNow(roomId, reason = 'manual') { return dispatchTrigger(roomId, reason); }

  function applyRhythm(roomId, patch = {}) {
    const cfg = getConfig();
    const next = {};
    if (patch.state === 'dormant' || patch.state === 'engaged') next.state = patch.state;
    if (patch.dormantMs !== undefined) {
      const n = Number(patch.dormantMs);
      if (Number.isFinite(n)) next.dormantMs = Math.min(cfg.pacing.maxDormantMs, Math.max(cfg.pacing.minDormantMs, Math.round(n)));
    }
    const updated = roomStore.setRhythm(roomId, next);
    if (updated.state === 'dormant') armDormantTimer(roomId);
    else clearDormant(roomId);
    return updated;
  }

  function waitForMessages(roomId, { timeoutMs = 15000, quietMs = 0 } = {}) {
    if (closed) return Promise.resolve({ ok: true, aborted: true, messages: [] });
    const maxWait = Math.min(120000, Math.max(100, Number(timeoutMs) || 15000));
    const quiet = Math.min(30000, Math.max(0, Number(quietMs) || 0));
    const collected = [];
    const set = waitQueues.get(roomId) ?? new Set();
    waitQueues.set(roomId, set);

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
        if (set.size === 0) waitQueues.delete(roomId);
        const st = roomStore.get(roomId);
        resolve({ ok: true, messages: collected, readCursor: st?.readCursor ?? 0, ...extra });
      };

      const waiter = {
        onMessage: (record) => {
          collected.push(record);
          if (quiet <= 0) finish({ timedOut: false });
          else {
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => finish({ timedOut: false, quietSettled: true }), quiet);
            quietTimer.unref?.();
          }
        },
        abort: () => finish({ aborted: true }),
      };

      set.add(waiter);
      totalTimer = setTimeout(() => finish({ timedOut: true }), maxWait);
      totalTimer.unref?.();
    });
  }

  function onRecall({ roomId, messageId } = {}) {
    if (!roomId || !messageId) return false;
    return roomStore.redactByMessageId(roomId, messageId);
  }

  function onNudge({ roomId, senderId, targetId, isTargetSelf } = {}) {
    if (closed || !roomId) return { accepted: false };
    const cfg = getConfig();
    if (!isRoomPermitted(cfg, roomId) || isSenderMuted(cfg, senderId)) return { accepted: false };
    const exec = resolveRoomExecution(cfg, roomId);
    if (exec.mode === 'muted') return { accepted: false };

    const actor = directory?.displayNameFor?.(roomId, senderId) || senderId || '成员';
    const target = isTargetSelf ? '你' : (directory?.displayNameFor?.(roomId, targetId) || targetId || '成员');
    const caps = memberGuard ? memberGuard.evaluateMember(roomId, senderId) : { canTrigger: true, inContext: true };
    const record = roomStore.recordInbound(roomId, {
      senderId,
      senderName: actor,
      text: `[轻拍] ${actor} 拍了拍 ${target}`,
      inContext: caps.inContext !== false,
    });
    if (isTargetSelf && caps.canTrigger !== false && !exec.paused && (exec.mode === 'ambient' || exec.mode === 'direct')) {
      scheduleCoalesce(roomId, 'nudge', cfg.pacing.coalesceMs);
      return { accepted: true, woken: true, seq: record.seq };
    }
    return { accepted: true, woken: false, seq: record.seq };
  }

  function cancelRoomTimers(roomId) {
    clearCoalesce(roomId);
    clearDormant(roomId);
    const set = waitQueues.get(roomId);
    if (set) {
      for (const w of [...set]) w.abort();
      waitQueues.delete(roomId);
    }
    log?.(`[pacing] 已清理房间 ${roomId} 定时器与等待器`);
  }

  function close() {
    closed = true;
    for (const k of [...coalesceTimers.keys()]) clearCoalesce(k);
    for (const k of [...dormantTimers.keys()]) clearDormant(k);
    for (const [, set] of waitQueues) {
      for (const w of [...set]) w.abort();
    }
    waitQueues.clear();
  }

  return {
    onInbound, onRecall, onNudge, triggerNow, applyRhythm, waitForMessages, cancelRoomTimers, close,
  };
}
