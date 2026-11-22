import { createTimerRegistry } from './timer.js';
import { createTurnEngine } from './turn-engine.js';
import { wakePriority, isTimerReason, isDirectedReason } from './trigger.js';

// 旧模式作为执行适配层：只在引擎出队后才构造唤醒提示词、创建会话并投递。
export function createSchedulerExecutor(b) {
  let sequence = 0;
  let recoverySnapshot = null;
  const runtime = new Map();
  const modeTimers = createTimerRegistry(b);
  const shadowEvents = [];
  const awaitingSnapshots = new Set(Object.values(b.state.sessions));
  const schedulerEnabled = (key) => (b.cfg.architecture?.gateV2 === true && key.startsWith('group:')) || b.cfg.architecture?.schedulerV2?.[b.modeForKey(key)] === true || b.cfg.modes?.engine?.[b.modeForKey(key)] === true;
  const allowed = (request) => {
    if (!b.isSessionAllowedInCurrentMode(request.conv) || b.modeForKey(request.conv) !== request.mode) return false;
    const reason = request.payload.wakeReason;
    if (!reason) return true;
    if (b.cfg.socialV2?.enabled === false || b.socialV2.paused) return false;
    if (isTimerReason(reason) || isDirectedReason(reason) || request.trigger.seq === 0) return true;
    return b.getSocialV2State(request.conv).unread.some((message) => Number(message.seq) >= request.trigger.seq);
  };
  const sessionBusy = (sessionId) => b.isSessionTurnBusy ? b.isSessionTurnBusy(sessionId) : Date.now() - Number(b.v2TurnStartAt.get(sessionId) || 0) < b.TURN_BUSY_LEASE_MS;
  const turnEngine = createTurnEngine({
    now: b.now, setTimeout: b.setTimeout, clearTimeout: b.clearTimeout,
    leaseMs: b.TURN_BUSY_LEASE_MS,
    maxConcurrent: b.cfg.architecture?.schedulerV2?.maxConcurrent ?? 4,
    ready: () => b.dshReady,
    allowed,
    available: (request) => {
      const sessionId = b.state.sessions[request.conv];
      return !sessionId || (!awaitingSnapshots.has(sessionId) && (!b.collectors.has(sessionId) || !sessionBusy(sessionId)));
    },
    externalRunning: () => [...b.collectors.keys()].filter((sessionId) => {
      const key = b.reverse.get(sessionId);
      return key && schedulerEnabled(key) && turnEngine.activeLease(key)?.sessionId !== sessionId && sessionBusy(sessionId);
    }).length,
    emit: (event) => {
      if (event.code === 'lease-expired') {
        b.pendingWakeKeys.delete(event.conv);
        b.disarmPendingWakeLease(event.conv);
      }
      b.log(`[scheduler] ${event.type} ${event.conv} turn=${event.turnId}${event.reason || event.code ? ` ${event.reason || event.code}` : ''}`);
    },
    execute: async (request) => {
      const opts = { ...request.payload.opts, schedulerTurnId: request.turnId };
      if (!b.dshReady) return { retry: true };
      if (request.payload.wakeReason) return b.executeWakePromptV2(request.conv, request.payload.wakeReason, opts);
      return b.deliverPromptNow(request.conv, request.payload.promptText, opts);
    },
  });
  // 影子引擎独立持有队列/租约；从不调用执行器或发送。
  const shadowEngine = createTurnEngine({
    setTimeout: b.setTimeout, clearTimeout: b.clearTimeout,
    allowed,
    ready: () => b.dshReady,
    execute: async () => ({ ok: true }),
    emit: (event) => {
      shadowEvents.push(event);
      if (shadowEvents.length > 1000) shadowEvents.shift();
      b.log(`[scheduler:shadow] ${event.type} ${event.conv} turn=${event.turnId}`);
    },
  });
  function requestFor(key, promptText, opts, wakeReason, windowMs = 0) {
    const timer = wakeReason && isTimerReason(wakeReason);
    const st = wakeReason ? b.getSocialV2State(key) : null;
    // 消息唤醒沿用未读 seq；独立定时/手动机会与普通 prompt 各自有新序号。
    const seq = wakeReason && !timer ? (st.lastUnreadSeq || 0) : ++sequence;
    const kind = ({ timeout: 'timer', replyCheck: 'replyCheck', proactiveCheck: 'proactive', bootstrap: 'bootstrap', admin: 'manual' })[String(wakeReason ?? '').split(':')[0]] ?? 'message';
    const decision = opts?.scheduleDecision;
    if (decision && ['immediate', 'manual'].includes(decision.strategy)) windowMs = 0;
    return { conv: key, mode: b.modeForKey(key), epoch: b.conversationEpoch?.(key) ?? 0, trigger: { kind, seq,
      strategy: decision?.strategy ?? (kind === 'manual' ? 'manual' : windowMs ? 'batched' : timer ? 'timer' : 'immediate'), reason: decision?.reason ?? wakeReason ?? 'prompt' },
      payload: { promptText, opts, wakeReason, sourceQqs: opts?.sourceQqs ?? (st?.unread ?? []).map(message => message.userId).filter(Boolean) }, priority: Math.max(decision?.priority ?? 0, wakePriority(wakeReason)), windowMs,
      batchKey: windowMs ? 'messages' : null,
      rate: { perMinute: Number(b.cfg.socialV2?.wake?.maxWakePerMinute) || 0, perHour: Number(b.cfg.socialV2?.wake?.maxWakePerHour) || 0 },
    };
  }
  function submit(request) {
    const result = turnEngine.schedule(request);
    // 忙/离线保持原有调用约定：立即告知排队，不让入站事件等待整个回合。
    if (result.status === 'stashed') return Promise.resolve({ ok: true, queued: true, turnId: result.turnId });
    return result.completion;
  }
  function schedulerSetTimer(key, slot, run, delay) {
    if (!schedulerEnabled(key) && b.cfg.modes?.engine?.[b.modeForKey(key)] !== true) return b.setTimeout(run, delay);
    return modeTimers.at(`${key}:${slot}`, Date.now() + delay, run);
  }
  function clearSchedulerTimer(timer) {
    if (timer?.cancel) { timer.cancel(); return; }
    b.clearTimeout(timer);
  }
  function scheduleDelayedPrompt(key, promptText, opts, delay) {
    const request = requestFor(key, promptText, opts);
    request.windowMs = delay;
    // 延迟只是执行时机；已有模式决策时不把消息伪装成 timer。
    if (!opts?.scheduleDecision) {
      request.trigger.kind = 'timer';
      request.trigger.strategy = 'timer';
    }
    return submit(request);
  }
  function cancelDelayedSocialReplies(key) { turnEngine.cancelDelayed(key, 'social-reply'); }
  function cancelAllDelayedSocialReplies() {
    for (const key of Object.keys(turnEngine.stats())) cancelDelayedSocialReplies(key);
  }
  function schedulePrompt(key, promptText, opts = {}) { return submit(requestFor(key, promptText, opts)); }
  function scheduleWakeTurn(key, reason, windowMs = 0, decision = null) { return submit(requestFor(key, '', { scheduleDecision: decision }, reason, windowMs)); }
  function observeScheduledPrompt(key, promptText, opts = {}) {
    if (!b.cfg.architecture?.schedulerV2?.shadow || schedulerEnabled(key)) return;
    if (opts.wakeReason && shadowEngine.stats(key).state !== 'idle') return;
    shadowEngine.schedule(requestFor(key, promptText, opts, opts.wakeReason));
  }
  function observeWakeCandidate(key, reason, windowMs, decision = null) {
    if (!b.cfg.architecture?.schedulerV2?.shadow || schedulerEnabled(key)) return;
    shadowEngine.schedule(requestFor(key, '', { scheduleDecision: decision }, reason, windowMs));
  }
  function replayScheduledTurns() { void turnEngine.replay(); void shadowEngine.replay(); }
  function schedulerRuntime(key, legacy) {
    if (b.cfg.architecture?.schedulerV2?.reserved2 !== true && b.cfg.modes?.engine?.reserved2 !== true) return legacy;
    if (!runtime.has(key)) runtime.set(key, {});
    return runtime.get(key);
  }
  function cancelScheduledTurns(key, reason) {
    modeTimers.clear(`${key}:`);
    for (const sessionId of [...awaitingSnapshots]) {
      if (b.reverse.get(sessionId) === key || b.state.sessions?.[key] === sessionId) {
        awaitingSnapshots.delete(sessionId);
        modeTimers.cancel(`snapshot:${sessionId}`);
      }
    }
    turnEngine.cancel(key, { reason });
    shadowEngine.cancel(key, { reason });
  }
  function cancelAllScheduledTurns(reason) {
    modeTimers.clear();
    awaitingSnapshots.clear();
    for (const key of new Set([...Object.keys(turnEngine.stats()), ...Object.keys(shadowEngine.stats())])) cancelScheduledTurns(key, reason);
  }
  function scheduledTurnEvent(key, sessionId, event) {
    if (event.type === 'turn/start') bindShadowTurn(key, sessionId);
    turnEngine.event(key, sessionId, event); shadowEngine.event(key, sessionId, event); }
  function settleScheduledTurn(key, sessionId, turn, outcome = 'completed') {
    turnEngine.settle(key, sessionId, turn, outcome);
    shadowEngine.settle(key, sessionId, turn, outcome);
    void turnEngine.replay();
  }
  function bindShadowTurn(key, sessionId) {
    const lease = shadowEngine.activeLease(key);
    if (lease) shadowEngine.bind(key, lease.turnId, sessionId);
  }
  function failScheduledTurn(key, sessionId, code, turnId) {
    const lease = turnEngine.activeLease(key);
    if (lease?.sessionId === sessionId && lease.turnId === turnId) turnEngine.finish(key, lease.turnId, code);
  }
  function awaitSnapshot(sessionId) {
    awaitingSnapshots.add(sessionId);
    modeTimers.at(`snapshot:${sessionId}`, Date.now() + b.TURN_BUSY_LEASE_MS, () => {
      if (!awaitingSnapshots.delete(sessionId)) return;
      b.log(`[scheduler] 快照等待超出租约，恢复调度 ${sessionId}`);
      void turnEngine.replay();
    });
  }
  function suspendScheduledTurns() {
    recoverySnapshot = turnEngine.snapshot();
    for (const sessionId of Object.values(b.state.sessions)) awaitSnapshot(sessionId);
  }
  function prepareScheduledSnapshot(sessionId, records) {
    if (recoverySnapshot) {
      turnEngine.restore(recoverySnapshot);
      recoverySnapshot = null;
    }
    const key = b.reverse.get(sessionId);
    const lease = key && turnEngine.activeLease(key);
    if (!lease || lease.sessionId !== sessionId) return;
    const entries = records.map((entry) => ({ event: entry?.type === 'event' ? entry.event : entry, seq: Number(entry?.seq ?? entry?.event?.seq ?? -1) }));
    const afterEntry = (entry) => entry.seq > lease.afterSeq || (lease.afterSeq < 0 && entry.seq === -1);
    if (!lease.transportTurn) {
      const candidate = entries.find((entry) => entry.event?.type === 'turn/start' && afterEntry(entry));
      if (!candidate) return;
      turnEngine.event(key, sessionId, candidate.event);
      // prompt 已接纳但 start 帧丢失时，先建立游标，避免把完成快照当历史跳过。
      b.markTurnStarted(sessionId, candidate.event.data.turn, candidate.seq);
    }
    for (const entry of entries) {
      if (afterEntry(entry) && (entry.event?.type === 'tool/call' || entry.event?.type === 'tool/result')) {
        turnEngine.event(key, sessionId, entry.event);
      }
    }
    // 静默摘要只消费完成证据，不经普通文本补发；仍保留在途静默名额。
    const ended = entries.find(entry => entry.event?.type === 'turn/end' && entry.event.data?.turn === lease.transportTurn);
    if (ended && turnEngine.activeRequest(key)?.payload.opts?.silent) {
      b.markTurnDelivered(sessionId, lease.transportTurn, ended.seq);
      if (!lease.silentSnapshotSettled) {
        lease.silentSnapshotSettled = true;
        const silent = b.social.silentTurns.get(sessionId);
        silent?.shift();
        if (silent?.length === 0) b.social.silentTurns.delete(sessionId);
      }
    }
  }
  function reconcileScheduledSnapshot(sessionId, records) {
    awaitingSnapshots.delete(sessionId);
    modeTimers.cancel(`snapshot:${sessionId}`);
    const key = b.reverse.get(sessionId);
    const lease = key && turnEngine.activeLease(key);
    if (!lease || lease.sessionId !== sessionId) { void turnEngine.replay(); return; }
    const events = records.map((entry) => entry?.type === 'event' ? entry.event : entry);
    const ended = lease.transportTurn && events.find((event) => event?.type === 'turn/end' && event.data?.turn === lease.transportTurn);
    if (turnEngine.activeRequest(key)?.payload.wakeReason) {
      if (ended) {
        b.pendingWakeKeys.delete(key);
        b.disarmPendingWakeLease(key);
        b.ensureWakeableV2(b.getSocialV2State(key), { key });
      } else {
        b.pendingWakeKeys.add(key);
      }
    }
    // live end 已把发送排入队列时，settling 的释放权仍属于原派发闭包。
    if (ended && turnEngine.stats(key).state !== 'settling') settleScheduledTurn(key, sessionId, lease.transportTurn, ended.data?.reason?.kind);
    void turnEngine.replay();
  }
  for (const sessionId of awaitingSnapshots) awaitSnapshot(sessionId);
  function schedulerDiagnostics() {
    const turns = turnEngine.stats();
    return { turns, timers: modeTimers.entries(), leases: Object.keys(turns).flatMap((key) => {
      const lease = turnEngine.activeLease(key);
      return lease ? [{ key, ...lease }] : [];
    }) };
  }
  return { schedulerDiagnostics, schedulerSetTimer, clearSchedulerTimer, scheduleDelayedPrompt, cancelDelayedSocialReplies, cancelAllDelayedSocialReplies, turnEngine, schedulerEnabled, schedulerRuntime, schedulePrompt, scheduleWakeTurn, observeScheduledPrompt, observeWakeCandidate, replayScheduledTurns, bindShadowTurn, shadowEvents,
    failScheduledTurn, suspendScheduledTurns, cancelScheduledTurns, cancelAllScheduledTurns, scheduledTurnEvent, settleScheduledTurn, prepareScheduledSnapshot, reconcileScheduledSnapshot };
}
