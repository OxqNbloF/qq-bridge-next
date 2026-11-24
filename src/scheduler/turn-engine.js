import { createHash } from 'node:crypto';
import { createTimerRegistry } from './timer.js';
import { compareRequests, rateDelay } from './queue.js';
import { createLease } from './lease.js';

// 只调度请求，不理解提示词、模式状态或 QQ 发送。
export function createTurnEngine({ execute, allowed = () => true, ready = () => true, available = () => true, externalRunning = () => 0, emit = () => {}, now = Date.now, setTimeout, clearTimeout, maxConcurrent = 4, leaseMs = 900000 }) {
  const conversations = new Map();
  const completed = new Set();
  const paused = new Set();
  const timers = createTimerRegistry({ setTimeout, clearTimeout, now });
  let order = 0;
  let draining = false;
  let drainAgain = false;
  const stateFor = (conv) => {
    if (!conversations.has(conv)) conversations.set(conv, { queue: [], active: null, times: [], lastTurn: null, stalled: 0 });
    return conversations.get(conv);
  };
  const signal = (type, entry, details = {}) => emit({ type, conv: entry.request.conv, turnId: entry.request.turnId, ...details });
  function remember(id) {
    completed.add(id);
    // shortcut: 进程内保留最近 10000 个已完成请求，持久化调度上线时改用持久幂等表。
    if (completed.size > 10000) completed.delete(completed.values().next().value);
  }
  function finish(conv, turnId, outcome = 'completed') {
    const state = conversations.get(conv);
    const entry = state?.active;
    if (!entry || entry.request.turnId !== turnId) return false;
    state.active = null;
    state.lastTurn = turnId;
    remember(turnId);
    timers.cancel(`lease:${conv}`);
    signal(outcome === 'completed' ? 'turn:end' : 'turn:error', entry, { outcome, code: outcome });
    entry.resolve({ ok: outcome === 'completed', error: outcome, turnId });
    void drain();
    return true;
  }
  function armLease(conv, state, entry) {
    timers.at(`lease:${conv}`, Math.max(now() + 1, entry.lease.expiresAt), () => {
      if (state.active !== entry || entry.phase === 'settling') return;
      const currentNow = now();
      if ((entry.lease.pendingToolCalls?.length ?? 0) > 0 && entry.lease.toolCallAt > 0 && currentNow - entry.lease.toolCallAt < leaseMs) {
        const nextExpiresAt = Math.min(entry.lease.startedAt + leaseMs * 2, entry.lease.toolCallAt + leaseMs);
        if (nextExpiresAt > entry.lease.expiresAt) {
          entry.lease.toolExtended = true;
          entry.lease.expiresAt = nextExpiresAt;
          armLease(conv, state, entry);
          return;
        }
      }
      // 保留 collector，由传输侧接收迟到输出；新的请求可以继续调度。
      state.stalled += 1;
      finish(conv, entry.request.turnId, 'lease-expired');
    });
  }
  async function run(state, entry) {
    const request = entry.request;
    entry.lease = createLease(request.turnId, now(), leaseMs, request.conv, request.trigger.kind);
    entry.phase = 'queued';
    entry.delivery = 'unknown'; // execute 一旦起跑，除明确 retry 外不能假定未接纳。
    state.active = entry;
    armLease(request.conv, state, entry);
    try {
      const result = await execute(request);
      if (state.active !== entry) return;
      if (result?.retry) {
        state.active = null;
        timers.cancel(`lease:${request.conv}`);
        entry.delivery = 'undelivered';
        entry.attempts += 1;
        entry.readyAt = now() + Math.min(60000, 1000 * 2 ** Math.min(entry.attempts, 6));
        state.queue.push(entry);
        entry.resolve({ ok: true, queued: true, turnId: request.turnId });
        timers.at(`retry:${request.conv}`, entry.readyAt, () => { void drain(); });
        return;
      }
      if (!result || typeof result !== 'object' || result?.ok === false || result?.skipped || result?.command) {
        const resolved = (!result || typeof result !== 'object') ? { ok: true, skipped: true } : result;
        entry.resolve(resolved);
        finish(request.conv, request.turnId, resolved?.ok === false ? 'rejected' : 'completed');
        return;
      }
      entry.phase = 'running';
      entry.delivery = 'accepted';
      state.times = state.times.filter((time) => now() - time < 3600000);
      state.times.push(now());
      signal('turn:start', entry);
      entry.resolve({ ...result, ok: true, turnId: request.turnId });
      if (entry.ended) finish(request.conv, request.turnId, entry.ended);
    } catch (error) {
      // 已发出的请求可能被服务端接纳；异常不自动重发，避免重复回复。
      entry.resolve({ ok: false, error: String(error?.message ?? error), turnId: request.turnId });
      finish(request.conv, request.turnId, 'dispatch-error');
    } finally { void drain(); }
  }
  async function drain() {
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      for (const state of conversations.values()) for (const entry of state.queue) {
        if (entry.phase === 'batching' && entry.readyAt <= now()) entry.phase = 'queued';
      }
      if (!ready() || paused.has('*')) return;
      const running = [...conversations.values()].filter((state) => state.active).length + externalRunning();
      let slots = Math.max(0, maxConcurrent - running);
      const candidates = [...conversations.entries()].filter(([conv, state]) => !state.active && state.queue.length && !paused.has(conv))
        .map(([conv, state]) => {
          state.queue.sort(compareRequests);
          // 优先选取已到期的最高优项，消除高优延迟项阻塞已就绪低优项的队头阻塞
          const readyIdx = state.queue.findIndex((item) => item.readyAt <= now());
          const idx = readyIdx >= 0 ? readyIdx : 0;
          return { conv, state, entry: state.queue[idx], idx };
        })
        .sort((a, b) => compareRequests(a.entry, b.entry));
      for (const { conv, state, entry, idx } of candidates) {
        if (slots <= 0) break;
        if (!allowed(entry.request)) {
          state.queue.splice(idx, 1);
          remember(entry.request.turnId);
          signal('turn:skipped', entry, { reason: 'gate' });
          entry.resolve({ ok: true, skipped: true });
          drainAgain = true;
          continue;
        }
        if (!available(entry.request)) continue;
        const wait = Math.max(entry.readyAt - now(), rateDelay(state.times, entry.request.rate, now()));
        if (wait > 0) {
          if (entry.readyAt <= now() && !entry.rateNoted) {
            signal('turn:skipped', entry, { reason: 'rate' });
            entry.rateNoted = true;
          }
          const minDue = state.queue.reduce((m, item) => Math.min(m, Math.max(item.readyAt, now() + rateDelay(state.times, item.request.rate, now()))), now() + wait);
          timers.at(`retry:${conv}`, minDue, () => { void drain(); });
          continue;
        }
        state.queue.splice(idx, 1);
        slots -= 1;
        void run(state, entry);
      }
    } finally {
      draining = false;
      if (drainAgain) {
        drainAgain = false;
        void Promise.resolve().then(drain);
      }
    }
  }
  function schedule(input) {
    if (!/^(group|private):\d+$/.test(input.conv) || !['chat', 'closed-agent', 'reserved', 'reserved2'].includes(input.mode)
      || !input.trigger || !Number.isFinite(input.trigger.seq) || !['immediate', 'batched', 'probability', 'timer', 'manual'].includes(input.trigger.strategy)) throw new Error('非法 TurnRequest');
    const idParts = [input.conv, input.mode, input.trigger.kind, input.trigger.seq, input.trigger.strategy];
    if (Number.isFinite(input.epoch) && input.epoch > 0) idParts.push(input.epoch);
    const turnId = input.turnId ?? createHash('sha256').update(JSON.stringify(idParts)).digest('hex').slice(0, 24);
    const request = { ...input, priority: input.priority ?? 0, turnId };
    const state = stateFor(request.conv);
    const existing = [state.active, ...state.queue].find((entry) => entry?.request.turnId === turnId);
    if (existing) return { status: 'merged', turnId, completion: existing.completion };
    if (completed.has(turnId)) return { status: 'dropped', turnId, completion: Promise.resolve({ ok: true, skipped: true, turnId }) };
    if (!allowed(request)) {
      emit({ type: 'turn:skipped', conv: request.conv, turnId, reason: 'gate' });
      return { status: 'dropped', turnId, completion: Promise.resolve({ ok: true, skipped: true, turnId }) };
    }
    const batch = request.batchKey && state.queue.find((entry) => entry.request.batchKey === request.batchKey && entry.readyAt > now());
    if (batch) {
      // 来源属于整个合批；优先级只选择主负载和原因，不能缩小发送复查范围。
      const sourceQqs = [...new Set([...(batch.request.payload.sourceQqs ?? []), ...(request.payload.sourceQqs ?? [])])];
      if (request.priority > batch.request.priority) {
        batch.request.payload = request.payload;
        batch.request.priority = request.priority;
        batch.request.trigger.reason = request.trigger.reason;
      }
      batch.request.payload = { ...batch.request.payload, sourceQqs };
      batch.request.trigger.seq = Math.min(batch.request.trigger.seq, request.trigger.seq);
      remember(turnId);
      return { status: 'merged', turnId: batch.request.turnId, completion: batch.completion };
    }
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const entry = { request, completion, resolve, order: ++order, attempts: 0, readyAt: now() + Math.max(0, Math.min(input.windowMs ?? 0, input.maxWaitMs ?? Infinity)), phase: 'queued', delivery: 'undelivered', lease: null };
    if (state.queue.length >= 50) {
      const oldest = state.queue.reduce((a, b) => a.order < b.order ? a : b);
      state.queue.splice(state.queue.indexOf(oldest), 1);
      timers.cancel(`batch:${request.conv}:${oldest.request.turnId}`);
      remember(oldest.request.turnId);
      signal('turn:skipped', oldest, { reason: 'backlog' });
      oldest.resolve({ ok: true, skipped: true });
    }
    if (['batched', 'probability'].includes(request.trigger.strategy) && entry.readyAt > now()) entry.phase = 'batching';
    state.queue.push(entry);
    if (entry.phase === 'batching') timers.at(`batch:${request.conv}:${turnId}`, entry.readyAt, () => {
      entry.phase = 'queued';
      void drain();
    });
    const stashed = !!state.active || !ready() || !available(request) || paused.has('*') || paused.has(input.conv) || rateDelay(state.times, request.rate, now()) > 0
      || [...conversations.values()].filter((value) => value.active).length + externalRunning() >= maxConcurrent;
    void drain();
    return { status: stashed ? 'stashed' : 'accepted', turnId, completion };
  }
  function bind(conv, turnId, sessionId, afterSeq = -1) {
    const entry = conversations.get(conv)?.active;
    if (!entry || entry.request.turnId !== turnId) return false;
    entry.lease.sessionId = sessionId;
    entry.lease.afterSeq = afterSeq;
    return true;
  }
  function event(conv, sessionId, event) {
    const entry = conversations.get(conv)?.active;
    if (!entry || entry.lease.sessionId !== sessionId) return;
    entry.lease.lastEventAt = now();
    if (event.type === 'turn/start' && !entry.lease.transportTurn) entry.lease.transportTurn = event.data?.turn;
    if (event.type === 'tool/call') {
      if (event.data?.callId != null) {
        const pending = new Set(entry.lease.pendingToolCalls ?? []);
        pending.add(String(event.data.callId));
        entry.lease.pendingToolCalls = [...pending];
      }
      entry.lease.toolCallAt = now();
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.callId;
      if (callId != null && Array.isArray(entry.lease.pendingToolCalls)) {
        entry.lease.pendingToolCalls = entry.lease.pendingToolCalls.filter((id) => id !== String(callId));
      }
    }
    if (event.type === 'turn/end' && entry.phase === 'running' && entry.lease.transportTurn === event.data?.turn) entry.phase = 'settling';
  }
  function settle(conv, sessionId, transportTurn, outcome = 'completed') {
    const entry = conversations.get(conv)?.active;
    if (!entry || entry.lease.sessionId !== sessionId || !entry.lease.transportTurn || entry.lease.transportTurn !== transportTurn) return;
    if (entry.phase === 'queued') { entry.ended = outcome; return; }
    entry.phase = 'settling';
    finish(conv, entry.request.turnId, outcome);
  }
  function cancel(conv, { reason = 'cancelled' } = {}) {
    const state = conversations.get(conv);
    if (!state) return;
    const entries = [...state.queue, ...(state.active ? [state.active] : [])];
    state.queue = [];
    state.active = null;
    timers.cancel(`lease:${conv}`);
    timers.cancel(`retry:${conv}`);
    for (const entry of entries) {
      timers.cancel(`batch:${conv}:${entry.request.turnId}`);
      if (entry.delivery !== 'undelivered') remember(entry.request.turnId);
      signal('turn:skipped', entry, { reason });
      entry.resolve({ ok: true, skipped: true, turnId: entry.request.turnId });
    }
    void drain();
  }
  function cancelPending(conv, matches, reason) {
    const state = conversations.get(conv);
    if (!state) return;
    const cancelled = state.queue.filter((entry) => entry.readyAt > now() && matches(entry.request));
    for (const entry of cancelled) {
      timers.cancel(`batch:${conv}:${entry.request.turnId}`);
      signal('turn:skipped', entry, { reason });
      entry.resolve({ ok: true, skipped: true });
    }
    state.queue = state.queue.filter((entry) => !cancelled.includes(entry));
    void drain();
  }
  function cancelBatches(conv) { cancelPending(conv, (request) => request.batchKey, 'batch-cancelled'); }
  function cancelDelayed(conv, tag) { cancelPending(conv, (request) => request.payload.opts?.schedulerTag === tag, 'delay-cancelled'); }
  function stats(conv) {
    if (conv == null) return Object.fromEntries([...conversations.keys()].map((key) => [key, stats(key)]));
    const state = conversations.get(conv);
    return { state: state?.active?.phase ?? (state?.queue.some((entry) => entry.phase === 'batching') ? 'batching' : state?.queue.length ? 'queued' : 'idle'), queueDepth: state?.queue.length ?? 0,
      wakePerHour: state?.times.filter((time) => now() - time < 3600000).length ?? 0, lastTurn: state?.lastTurn ?? null, stalled: state?.stalled ?? 0 };
  }
  function snapshot() {
    return structuredClone({ version: 1, completed: [...completed], conversations: [...conversations].map(([conv, state]) => ({ conv, times: state.times, lastTurn: state.lastTurn, stalled: state.stalled,
      queue: state.queue.map((entry) => ({ request: entry.request, readyAt: entry.readyAt, order: entry.order, attempts: entry.attempts, phase: entry.phase, delivery: entry.delivery })),
      active: state.active ? { request: state.active.request, lease: state.active.lease, phase: state.active.phase, delivery: state.active.delivery } : null })) });
  }
  function restore(snap) {
    if (snap?.version !== 1 || !Array.isArray(snap.conversations) || !Array.isArray(snap.completed)) throw new Error('非法调度快照');
    // 同进程重连采用单调合并：绝不替换运行闭包/Promise，也不回滚完成墓碑。
    // 空引擎仍可导入快照；活跃请求只能等待传输结束，不能重新 execute。
    for (const id of snap.completed) remember(id);
    for (const item of snap.conversations) {
      const known = conversations.has(item.conv);
      const state = stateFor(item.conv);
      if (!known) {
        state.times = [...item.times];
        state.lastTurn = item.lastTurn;
        state.stalled = item.stalled;
      }
      const has = (id) => completed.has(id) || state.active?.request.turnId === id || state.queue.some(entry => entry.request.turnId === id);
      const restoreEntry = (saved) => {
        let resolve;
        const completion = new Promise(done => { resolve = done; });
        return { ...structuredClone(saved), resolve, completion };
      };
      for (const pending of item.queue) {
        if (has(pending.request.turnId)) continue;
        const phase = ['batched', 'probability'].includes(pending.request.trigger.strategy) && pending.readyAt > now() ? 'batching' : 'queued';
        const entry = { ...restoreEntry(pending), phase, lease: null };
        if (phase === 'batching') timers.at(`batch:${item.conv}:${entry.request.turnId}`, entry.readyAt, () => { entry.phase = 'queued'; void drain(); });
        state.queue.push(entry);
        order = Math.max(order, pending.order);
      }
      if (item.active && !state.active && !has(item.active.request.turnId)) {
        // 导入到空引擎没有旧 execute/出站闭包，等待传输证据或原租约兜底。
        const entry = { ...restoreEntry(item.active), phase: 'running' };
        state.active = entry;
        armLease(item.conv, state, entry);
      }
    }
    void drain();
  }
  return { schedule, bind, event, settle, cancel, cancelBatches, cancelDelayed, finish, stats, snapshot, restore, replay: drain,
    isBusy: (conv) => !!conversations.get(conv)?.active,
    isCurrent: (conv, turnId) => conversations.get(conv)?.active?.request.turnId === turnId,
    pause: (scope = '*') => paused.add(scope), resume: (scope = '*') => { paused.delete(scope); void drain(); },
    activeSessions: () => [...conversations.values()].flatMap((state) => state.active?.phase !== 'settling' && state.active?.lease.sessionId ? [state.active.lease.sessionId] : []),
    activeRequest: (conv) => conversations.get(conv)?.active?.request ?? null,
    activeLease: (conv) => conversations.get(conv)?.active?.lease ?? null,
  };
}
