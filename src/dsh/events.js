// 接收 DSH 的事件：收集一个回合，再把回复发到 QQ
import { createTurnCollector } from '../dsh-client.js';
import { isSendToolName } from '../policy/audit.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { createTurnWatchdog } from '../scheduler/watchdog.js';
import { createTurnLifecycle } from '../scheduler/turn-lifecycle.js';

// 创建 DSH 事件处理模块
export function createDshEvents(b) {
  // 本模块自己记的状态，别的模块通过 b 读
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // 会话 -> 回合开始时间，用来判断有没有做事
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  const pendingWakeKeys = new Set();
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  // DSH 事件流 → QQ

  // collector 的摄入位置随对象存活；快照只追加缺帧，不重置已收文本。
  const collectorReceipts = new WeakMap();
  function pushCollected(collector, event, replayCounts = null, observe = () => {}) {
    let receipts = collectorReceipts.get(collector);
    if (!receipts) collectorReceipts.set(collector, receipts = new Map());
    const key = Number.isFinite(event.seq) ? `seq:${event.seq}` : JSON.stringify(event);
    const count = (replayCounts?.get(key) ?? 0) + 1;
    replayCounts?.set(key, count);
    const dedupeLive = Number.isFinite(event.seq) || event?.type !== 'assistant/chunk';
    if ((replayCounts || dedupeLive) && (receipts.get(key) ?? 0) >= count) return null;
    receipts.set(key, replayCounts ? count : (receipts.get(key) ?? 0) + 1);
    observe(event);
    return collector.push(event);
  }

  /** 收一条事件：只在回合开始时收集，回合结束就清掉 */
  function trackTurnEvent(sessionId, event) {
    // 记录这场对话进行到哪：开始和结束都要记
    if (event?.type === 'turn/start') b.markTurnStarted(sessionId, event.data?.turn, event.seq);
    let collector = b.collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      b.collectors.set(sessionId, collector);
    }
    const ended = collector ? pushCollected(collector, event) : null;
    if (ended) {
      // 回合正常结束，马上收起收集器
      b.markTurnDelivered(sessionId, ended.turn, event?.seq);
      b.collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      b.collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  // 每个聊天单独排队发，一个卡住不影响别的聊天
  const DISPATCH_MAX_BACKLOG = 20; // 同会话积压上限：超出丢最旧的一条「回合发送」
  const DISPATCH_SLOW_MS = 60_000; // 超过这么久只记警告：队列还是等它跑完才做下一件
  const DISPATCH_DRAIN_MS = 5_000; // 断线时等在途队列的上限
  const dispatchQueues = new Map(); // 聊天 -> 排队中的任务和正在跑的任务
  const dispatchStats = { maxDepth: 0, slowestMs: 0, dropped: 0, overtime: 0 };

  // 把一个任务排进这个聊天的队列
  function dispatch(sessionId, droppable, run, onDrop = () => {}) {
    // 回滚开关：dsh.inlineDispatch=true 恢复「泵内联 await」的旧行为。
    if (b.cfg.dsh?.inlineDispatch === true) return run();
    let queue = dispatchQueues.get(sessionId);
    if (!queue) dispatchQueues.set(sessionId, queue = { tasks: [], running: null });
    if (queue.tasks.length >= DISPATCH_MAX_BACKLOG) {
      // 积压太多就丢最旧的；全是不能丢的也丢最旧，防止无限涨
      let oldest = queue.tasks.findIndex((task) => task.droppable);
      if (oldest < 0 && queue.tasks.length >= DISPATCH_MAX_BACKLOG * 2) oldest = 0;
      if (oldest >= 0) {
        const [dropped] = queue.tasks.splice(oldest, 1);
        dropped.onDrop();
        dispatchStats.dropped += 1;
        b.log(`⚠️ 会话 ${sessionId} 出站积压超过 ${DISPATCH_MAX_BACKLOG} 条，丢弃最旧的一条回合发送`);
      }
    }
    queue.tasks.push({ droppable, run, onDrop });
    const depth = queue.tasks.length + (queue.running ? 1 : 0);
    if (depth > dispatchStats.maxDepth) dispatchStats.maxDepth = depth;
    if (depth === 5) b.log(`会话 ${sessionId} 出站队列深度 ${depth}`);
    if (!queue.running) queue.running = runDispatchQueue(sessionId, queue);
    return undefined;
  }

  // 按顺序跑这个聊天队列里的任务
  async function runDispatchQueue(sessionId, queue) {
    while (queue.tasks.length) {
      const task = queue.tasks.shift();
      const startedAt = Date.now();
      const slowTimer = b.setTimeout(() => {
        dispatchStats.overtime += 1;
        b.log(`⚠️ 会话 ${sessionId} 一次出站已超过 ${b.cfg.dsh?.dispatchSlowMs ?? DISPATCH_SLOW_MS}ms 仍未结束，本会话后续出站继续排队等待`);
      }, b.cfg.dsh?.dispatchSlowMs ?? DISPATCH_SLOW_MS);
      try {
        // 空闲队列的第一个任务在这里同步起跑（到它的第一个 await 为止），与旧的内联时序一致。
        await task.run();
      } catch (error) {
        // 队列内异常只记日志，不打断 DSH 事件流。
        b.log(`出站派发失败 (${sessionId}): ${error?.message ?? error}`);
      } finally { b.clearTimeout(slowTimer); }
      const elapsed = Date.now() - startedAt;
      if (elapsed > dispatchStats.slowestMs) dispatchStats.slowestMs = elapsed;
      if (elapsed >= 5000) b.log(`会话 ${sessionId} 一次出站耗时 ${elapsed}ms`);
    }
    if (dispatchQueues.get(sessionId) === queue) dispatchQueues.delete(sessionId);
  }

  // 断线清理前先等在途队列（有上限）。超时仍未轮到的任务**保留**：它们的回合已记为「已交付」，
  // 重连后的快照补发不会再发一遍，丢掉就是漏回复；每个任务开跑时自己复查会话是否仍是当前会话。
  async function drainDispatch() {
    const running = [...dispatchQueues.values()].map((queue) => queue.running);
    if (!running.length) return;
    await Promise.race([Promise.allSettled(running), b.sleep(DISPATCH_DRAIN_MS)]);
    for (const [sessionId, queue] of dispatchQueues) {
      if (queue.tasks.length) b.log(`事件流断开：会话 ${sessionId} 还有 ${queue.tasks.length} 个出站任务未轮到，重连后继续`);
    }
  }

  const { checkStalledTurns, lastEventAt, toolCallAt } = createTurnWatchdog(b, {
    v2TurnStartAt, turnLeaseNoted, sendToolSucceededSessions, pendingSendToolCalls, toolCallNames, pendingWakeKeys, dispatch,
  });
  const { handleEndedTurn } = createTurnLifecycle(b, {
    v2TurnStartAt, lastEventAt, turnLeaseNoted, sendToolSucceededSessions, pendingSendToolCalls, toolCallNames, toolCallAt,
    pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, dispatch,
  });
  let stallTimer = null;

  // 打开 DSH 事件流，每次连接前先刷新权限
  async function* sessionEvents() {
    // 先验证模式和预设再订阅，免得权限还没确认
    // 每次连接都重新读 DSH：断线期间模式/管理员/preset 也可能已变，旧缓存不足以授权。
    await b.withTimeout(b.refreshMode({ requireOnline: true }), b.DSH_CONTROL_TIMEOUT_MS, '恢复会话模式校验');
    await b.withTimeout(b.refreshPresetList({ requireOnline: true }), b.DSH_CONTROL_TIMEOUT_MS, '恢复会话 preset 校验');
    b.reconcileSessionPolicies();
    for (const sessionId of Object.values(b.state.sessions)) b.api.events.follow(sessionId);
    yield* b.api.events.mux({});
  }

  // 一直连着 DSH 事件流，断了就重连
  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    if (!stallTimer) {
      stallTimer = b.setInterval(() => { try { checkStalledTurns(); } catch (error) { b.log('卡死回合检查失败:', error?.message ?? error); } }, 30_000);
      stallTimer?.unref?.();
    }
    for (;;) {
      let framesThisStream = 0;
      try {
        b.log('连接 DSH 事件流…');
        for await (const envelope of sessionEvents()) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：喂 token 账本 + 重建未结束回合；其中的**历史** turn/end 绝不能
          // 走 session/event 通道（那会把早已结束的回合当成新回合去发 QQ 回复）。
          // 断线时完成的回合，重连后按记到哪补发，重复的跳过
          if (frame.type === 'session/snapshot') {
            // 同步前缀（账本 + 重建在途 collector）立即执行；补发在自己的交付锁下跑，
            // 并挂进该会话的派发队列，保证之后的 live 发送排在补发后面。
            const replay = b.handleSessionSnapshot(frame.sessionId, frame.snapshot);
            await dispatch(frame.sessionId, false, () => replay);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            b.recordSessionUsage(frame.sessionId, frame.event);
            const key = b.reverse.get(frame.sessionId);
            if (!key) {
              // 记忆整理会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (b.learnerSessions.has(frame.sessionId)) {
                // 学习会话也只在回合开始时建收集器
                let learnerCollector = b.learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  b.learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  b.learnerCollectors.delete(frame.sessionId);
                  const waiters = b.learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) b.learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    b.clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== b.memoryLearnerSessionId) {
                    b.learnerSessions.delete(frame.sessionId);
                    b.api.events.forget?.(frame.sessionId);
                    b.modelAppliedSessions.delete(frame.sessionId);
                  }
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!b.isCurrentSession(key, frame.sessionId)) continue;
            const seq = frame.event.seq;
            if (Number.isFinite(seq) && (seq <= (b.deliveryCursors?.get(frame.sessionId)?.deliveredSeq ?? -1)
              || collectorReceipts.get(b.collectors.get(frame.sessionId))?.has(`seq:${seq}`))) continue;
            b.scheduledTurnEvent?.(key, frame.sessionId, frame.event);
            lastEventAt.set(frame.sessionId, Date.now()); // 卡死看门狗的滑动基准
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = b.sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              b.appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
                toolCallAt.set(frame.sessionId, Date.now());
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              b.appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? b.sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // 只为回合开始建收集器，空的回合结束就清掉
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) await handleEndedTurn(key, frame.sessionId, ended);
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && b.learnerSessions.has(frame.sessionId)) {
            // 记忆整理会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            await dispatch(frame.sessionId, false, async () => {
              const payload = frame.type === 'question/requested'
                ? {
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                }
                : {
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                };
              let lastError = null;
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  await b.withTimeout(b.api.respond(payload), 5000, '学习会话自动回执');
                  b.log('记忆整理会话自动跳过提问/审批');
                  return;
                } catch (error) {
                  lastError = error;
                }
              }
              b.log('自动响应学习会话提问/审批失败:', lastError?.message ?? lastError);
              b.appendActivity?.(`⚠️ 记忆学习会话自动跳过回执失败 (${frame.sessionId}): ${lastError?.message ?? lastError}`);
              b.invalidateMemoryLearnerSession?.(true);
            });
          } else if (frame.type === 'question/requested') {
            const key = b.reverse.get(frame.sessionId);
            if (!key) continue;
            const rpcId = envelope.rpcId;
            await dispatch(frame.sessionId, false, async () => {
              if (!b.isCurrentSession(key, frame.sessionId)) { await b.cancelPendingEntry({ ...frame, key, kind: 'question' }); return; }
              const lines = frame.questions.map((q, i) => {
                const qText = String(q.question ?? '');
                const sensitive = b.shouldAuditKey(key) && SENSITIVE_RE.test(qText);
                if (sensitive) b.log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
                const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
                let s = `${i + 1}. ${safeQuestion}`;
                if (q.options?.length) {
                  const opts = q.options.map((o) => {
                    const label = String(o.label ?? '');
                    const optSensitive = b.shouldAuditKey(key) && SENSITIVE_RE.test(label);
                    if (optSensitive) b.log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                    return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                  });
                  s += '\n   ' + opts.join(' ');
                }
                return s;
              });
              await b.sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
              await b.registerPending(key, { kind: 'question', rpcId: rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
            });
          } else if (frame.type === 'approval/requested') {
            const key = b.reverse.get(frame.sessionId);
            if (!key) continue;
            const rpcId = envelope.rpcId;
            await dispatch(frame.sessionId, false, async () => {
              if (!b.isCurrentSession(key, frame.sessionId)) { await b.cancelPendingEntry({ ...frame, key, kind: 'approval' }); return; }
              const rawReason = frame.reason ?? '';
              const sensitiveReason = b.shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
              if (sensitiveReason) b.log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
              const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
              const reason = safeReason ? `\n理由：${safeReason}` : '';
              const rawToolName = frame.toolName ?? '';
              const sensitiveTool = b.shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
              if (sensitiveTool) b.log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
              const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
              await b.sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
              await b.registerPending(key, { kind: 'approval', rpcId: rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
            });
          } else if (frame.type === 'stream/error') {
            b.log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        b.log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        b.log('事件流中断:', error?.message ?? error);
      } finally {
        b.suspendScheduledTurns?.();
        await drainDispatch();
        // 断线不是回合终结：运行闭包、collector、工具结果与静默名额保留到
        // snapshot/live end 或 watchdog 清理，不能把传输重连当成会话退役。
        // 也要清掉长轮询的租约，免得卡住这个聊天
        b.activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          b.log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await b.sleep(retryMs);
    }
  }

  /** 重连后把断线时还在跑的回合重新收起来 */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    // 从一条记录里取出事件本身
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    const cursor = b.deliveryCursors?.get(sessionId);
    for (const entry of records) {
      const event = eventOf(entry);
      const seq = entry?.seq ?? event?.seq;
      if (event?.type === 'turn/start' && event.data?.turn !== cursor?.deliveredTurn
        && !(Number.isFinite(seq) && seq <= (cursor?.deliveredSeq ?? -1))) open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    const existing = b.collectors.get(sessionId);
    // 已完成快照由 delivery cursor 补发，这里只收掉旧 collector 的占位。
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type !== 'turn/end' || !existing?.has(event.data?.turn)) continue;
      existing.push(event);
      if (existing.size() === 0) {
        b.collectors.delete(sessionId);
        v2TurnStartAt.delete(sessionId);
        lastEventAt.delete(sessionId);
        turnLeaseNoted.delete(sessionId);
        sendToolSucceededSessions.delete(sessionId);
        pendingSendToolCalls.delete(sessionId);
        toolCallNames.delete(sessionId);
        toolCallAt.delete(sessionId);
        const silent = b.social.silentTurns.get(sessionId);
        silent?.shift();
        if (silent?.length === 0) b.social.silentTurns.delete(sessionId);
        b.social.exitingSessions.delete(sessionId);
      }
    }
    if (!open.size) return;
    const collector = b.collectors.get(sessionId) ?? createTurnCollector();
    const replayCounts = new Map();
    let restored = 0;
    let currentTurn;
    const restoreTool = (event) => {
      if (event.type === 'tool/call' && event.data?.callId != null) {
        const id = String(event.data.callId), name = String(event.data.name ?? '');
        if (!toolCallNames.has(sessionId)) toolCallNames.set(sessionId, new Map());
        toolCallNames.get(sessionId).set(id, name);
        if (isSendToolName(name)) {
          if (!pendingSendToolCalls.has(sessionId)) pendingSendToolCalls.set(sessionId, new Set());
          pendingSendToolCalls.get(sessionId).add(event.data.callId);
        }
        if (!toolCallAt.has(sessionId)) toolCallAt.set(sessionId, Date.now());
      } else if (event.type === 'tool/result') {
        const id = String(event.data?.message?.source?.callId ?? '');
        const name = toolCallNames.get(sessionId)?.get(id);
        const message = event.data?.message;
        if (isSendToolName(name) && message?.isError !== true && message?.content?.[0]?.isError !== true) sendToolSucceededSessions.add(sessionId);
        toolCallNames.get(sessionId)?.delete(id);
        pendingSendToolCalls.get(sessionId)?.delete(event.data?.message?.source?.callId);
      }
    };
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') currentTurn = event.data?.turn;
      // 只恢复在途回合；快照中的工具不是重新调用，而是交付/看门狗证据。
      if (!['turn/start', 'assistant/message', 'tool/call', 'tool/result'].includes(event?.type)) continue;
      if (!open.has(event.data?.turn ?? currentTurn)) continue;
      pushCollected(collector, { ...event, seq: entry.seq ?? event.seq }, replayCounts, restoreTool);
      restored += 1;
    }
    if (!restored) return;
    b.collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) {
      // 起点提前一点，恢复的回合只再忙一小段
      v2TurnStartAt.set(sessionId, Date.now() - (b.TURN_BUSY_LEASE_MS - b.RESTORED_TURN_GRACE_MS));
    }
    b.log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  function isSessionTurnBusy(sessionId, now = Date.now()) {
    const startedAt = Number(v2TurnStartAt.get(sessionId) || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
    const leaseMs = b.TURN_BUSY_LEASE_MS;
    if (now - startedAt < leaseMs) return true;
    const lastToolAt = Number(toolCallAt.get(sessionId) || 0);
    return (toolCallNames.get(sessionId)?.size ?? 0) > 0
      && lastToolAt > 0
      && now - lastToolAt < leaseMs
      && now - startedAt < leaseMs * 2;
  }

  // sessionEvents 只有测试夹具从桥接里取（断言事件流内容），一并返回。
  return { dispatchSessionTask: dispatch,
    sendToolSucceededSessions, v2TurnStartAt, toolCallNames, toolCallAt, isSessionTurnBusy, pendingSendToolCalls, pendingWakeKeys, turnLeaseNoted, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, trackTurnEvent, pumpMux, rebuildInFlightCollector, sessionEvents, dispatchStats, checkStalledTurns };
}
