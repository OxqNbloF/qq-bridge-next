// 接收 DSH 的事件：收集一个回合，再把回复发到 QQ
import { createTurnCollector } from '../dsh-client.js';
import { mdToPlain } from '../md-to-plain.js';
import { isSendToolName, isSilentMarker, SILENT_MARKER } from '../policy/audit.js';
import { SENSITIVE_RE } from '../sensitive.js';

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

  /** 收一条事件：只在回合开始时收集，回合结束就清掉 */
  function trackTurnEvent(sessionId, event) {
    // 记录这场对话进行到哪：开始和结束都要记
    if (event?.type === 'turn/start') b.markTurnStarted(sessionId, event.data?.turn, event.seq);
    let collector = b.collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      b.collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
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
  function dispatch(sessionId, droppable, run) {
    // 回滚开关：dsh.inlineDispatch=true 恢复「泵内联 await」的旧行为。
    if (b.cfg.dsh?.inlineDispatch === true) return run();
    let queue = dispatchQueues.get(sessionId);
    if (!queue) dispatchQueues.set(sessionId, queue = { tasks: [], running: null });
    if (queue.tasks.length >= DISPATCH_MAX_BACKLOG) {
      // 积压太多就丢最旧的；全是不能丢的也丢最旧，防止无限涨
      let oldest = queue.tasks.findIndex((task) => task.droppable);
      if (oldest < 0 && queue.tasks.length >= DISPATCH_MAX_BACKLOG * 2) oldest = 0;
      if (oldest >= 0) {
        queue.tasks.splice(oldest, 1);
        dispatchStats.dropped += 1;
        b.log(`⚠️ 会话 ${sessionId} 出站积压超过 ${DISPATCH_MAX_BACKLOG} 条，丢弃最旧的一条回合发送`);
      }
    }
    queue.tasks.push({ droppable, run });
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

  // 回合卡住太久就取消：只影响这个聊天，别的照常
  const lastEventAt = new Map(); // sessionId -> 最近一次该会话事件的时间
  const toolCallAt = new Map(); // 会话 -> 最近一次工具调用时间，太久就不再宽容
  const stallNoticeAt = new Map(); // key -> 上次超时提示时间（限频）
  const STALL_NOTICE_INTERVAL_MS = 10 * 60 * 1000;
  let stallTimer = null;

  // 检查有没有卡死太久的回合
  function checkStalledTurns(now = Date.now()) {
    const stallMs = Number(b.cfg.turnStallMs ?? 5 * 60 * 1000);
    if (!(stallMs > 0)) return [];
    for (const [key, at] of stallNoticeAt) if (now - at >= STALL_NOTICE_INTERVAL_MS) stallNoticeAt.delete(key);
    const stalled = [];
    for (const sessionId of [...b.collectors.keys()]) {
      const key = b.reverse.get(sessionId);
      if (!key || b.modeForKey(key) === 'closed-agent') continue;
      const last = lastEventAt.get(sessionId) ?? v2TurnStartAt.get(sessionId);
      if (!last || now - last < stallMs) continue;
      // 有在途工具调用（长轮询等待）不算卡死；但工具结果永远不来（DSH 丢了）时不能永久豁免。
      if ((toolCallNames.get(sessionId)?.size ?? 0) > 0 && now - (toolCallAt.get(sessionId) ?? 0) < b.TURN_BUSY_LEASE_MS) continue;
      stalled.push(sessionId);
      b.log(`⚠️ 会话 ${key} 的回合 ${Math.round((now - last) / 1000)} 秒无事件，判定卡死：取消该会话当前回合并释放忙碌状态`);
      b.appendActivity(`${key} 回合卡死，已中断`);
      Promise.resolve().then(() => b.api.stopSessionWork(sessionId))
        .catch((error) => b.log(`取消卡死回合失败 (${key}): ${error?.message ?? error}`));
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

  // 回合结束后把回复发到 QQ
  async function deliverEndedTurn(key, ended, isFarewell, sendToolSucceeded) {
    if (ended.reason.kind === 'completed' && ended.text.trim()) {
      const plain = mdToPlain(ended.text);
      // 只有格式没有文字就当没回复
      if (!plain.trim()) {
        b.log(`agent 回复为空（仅格式/空白）(${key})`);
        if (isFarewell) {
          const st = b.socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            b.log(`社交模式：${key} 空退场回合，回到观望`);
          }
        }
        return;
      }
      // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
      if (isSilentMarker(plain)) {
        b.log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
        if (isFarewell) {
          const st = b.socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            b.log(`社交模式：${key} 退场选择静默，回到观望`);
          }
        }
        return;
      }
      // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
      if (sendToolSucceeded) {
        b.log(`工具已发送消息，跳过自动转发 (${key})`);
        if (isFarewell) {
          const st = b.socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            b.log(`社交模式：${key} 工具发送后退场完成，回到观望`);
          }
        }
        return;
      }
      // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
      const hasKnownToken = b.hasKnownTokenFragment(plain);
      if (b.shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
        b.log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
        b.appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
        if (b.cfg.security?.interceptNotify !== false) {
          await b.sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
        }
        if (isFarewell) {
          const st = b.socialState(key);
          if (st.phase === 'exiting') {
            st.phase = 'idle';
            st.activeDeadlineAt = 0;
            st.activeExitAt = 0;
            b.log(`社交模式：${key} 退场发言被拦截，回到观望`);
          }
        }
        return;
      }
      // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
      if (b.isSocialEnabled()) {
        if (b.shouldBlockSilentReply(key)) {
          b.log(`静默模式，拦截在途回复 (${key})`);
          b.appendActivity(`${key} 静默模式，拦截在途回复`);
          if (isFarewell) {
            const st = b.socialState(key);
            if (st.phase === 'exiting') {
              st.phase = 'idle';
              st.activeDeadlineAt = 0;
              st.activeExitAt = 0;
              b.log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
            }
          }
          return;
        }
        const timeline = b.planSocialTimeline(plain, b.cfg.social);
        const messages = timeline.main;
        b.log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
        b.appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
        if (messages.length > 1) {
          await b.sendBurstToQQ(key, messages, b.cfg.social);
        } else {
          await b.sendToQQ(key, messages[0], { ai: true });
        }
        // 发言后刷新活跃时间，并调度可能的二次补刀
        const st = b.socialState(key);
        if (isFarewell) {
          // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          b.log(`社交模式：${key} 退场发言完成，进入观望`);
        } else if (st.phase === 'exiting') {
          // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
          b.log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
        } else {
          if (b.lastSendSucceeded(key)) {
            st.lastActiveMessageAt = Date.now();
            st.lastAiReplyAt = Date.now();
            b.log(`社交模式：发言完成，刷新活跃时间 (${key})`);
          } else {
            // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
            // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
            // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
            b.log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
          }
        }
      } else if (b.modeForKey(key) === 'reserved2') {
        b.log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
        b.appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
      } else {
        if (b.shouldBlockSilentReply(key)) {
          b.log(`静默模式，拦截在途回复 (${key})`);
          b.appendActivity(`${key} 静默模式，拦截在途回复`);
          return;
        }
        b.log(`agent 回复 (${key}) ${plain.length} 字`);
        b.appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
        await b.sendToQQ(key, plain, { ai: true });
      }
    } else if (ended.reason.kind === 'error') {
      await b.reportTurnFailure(key, 'error', ended.reason.error);
      if (isFarewell) {
        const st = b.socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          b.log(`社交模式：${key} 退场发言出错，回到观望`);
        }
      }
    } else if (ended.reason.kind === 'aborted') {
      await b.reportTurnFailure(key, 'aborted');
      if (isFarewell) {
        const st = b.socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          b.log(`社交模式：${key} 退场发言中止，回到观望`);
        }
      }
    } else if (!ended.text.trim()) {
      // completed 但没文本（纯工具调用回合）
      b.log(`回合完成但无文本 (${key})`);
      if (isFarewell) {
        const st = b.socialState(key);
        if (st.phase === 'exiting') {
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          b.log(`社交模式：${key} 退场回合无文本，回到观望`);
        }
      }
    }
  }

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
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
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
                  if (frame.sessionId !== b.slangLearnerSessionId) {
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
            if (ended) {
              // 醒来什么都没做就累计一次，次数多了重置唤醒配置
              const silentQueueNow = b.social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (key && b.modeForKey(key) === 'reserved2' && !isSilentTurn) {
                const st = b.getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(b.cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      b.log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = b.defaultWakeConfigV2();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  b.markSocialV2Dirty(); // 泵内不做全量同步写（MB 级，会卡住所有会话的事件）：交给合批定时器
                } else {
                  b.log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              lastEventAt.delete(frame.sessionId);
              b.collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              toolCallAt.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = b.social.exitingSessions.has(frame.sessionId);
              if (isFarewell) b.social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = b.social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > b.SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) b.social.silentTurns.set(frame.sessionId, silentQueue);
                else b.social.silentTurns.delete(frame.sessionId);
                b.log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // 忘了设置下次唤醒就提醒，多次不改就恢复默认
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                b.disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  b.ensureWakeableV2(b.getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(b.cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    b.armPendingWakeLease(key);
                    b.deliverPrompt(key, b.buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        b.disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      b.disarmPendingWakeLease(key);
                      b.log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    b.log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = b.getSocialV2State(key);
                    st.wakeConfig = b.defaultWakeConfigV2();
                    b.markSocialV2Dirty();
                    b.log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 忙的时候先记下叫醒原因，这一轮结束后再补一次
              b.replayPendingWakeReasonsV2(key);
              const sessionId = frame.sessionId;
              await dispatch(sessionId, true, () => {
                // 排队期间会话可能被 /reset、重建或退役：旧会话的回复不再发到这个群。
                if (!b.isCurrentSession(key, sessionId)) { b.log(`会话 ${key} 已更换，丢弃旧会话 ${sessionId} 的回合发送`); return undefined; }
                return deliverEndedTurn(key, ended, isFarewell, sendToolSucceeded);
              });
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && b.learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            await dispatch(frame.sessionId, false, async () => {
              try {
                if (frame.type === 'question/requested') {
                  await b.api.respond({
                    clientId: frame.clientId,
                    eventId: frame.eventId,
                    outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                  });
                } else {
                  await b.api.respond({
                    clientId: frame.clientId,
                    eventId: frame.eventId,
                    outcome: { kind: 'result', value: 'rejected' }
                  });
                }
                b.log('黑话学习会话自动跳过提问/审批');
              } catch (error) {
                b.log('自动响应学习会话提问/审批失败:', error?.message ?? error);
              }
            });
          } else if (frame.type === 'question/requested') {
            const key = b.reverse.get(frame.sessionId);
            if (!key) continue;
            const rpcId = envelope.rpcId;
            await dispatch(frame.sessionId, false, async () => {
              if (!b.isCurrentSession(key, frame.sessionId)) { await b.cancelPendingEntry({ ...frame, kind: 'question' }); return; }
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
              if (!b.isCurrentSession(key, frame.sessionId)) { await b.cancelPendingEntry({ ...frame, kind: 'approval' }); return; }
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
        await drainDispatch();
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        b.collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        b.social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        lastEventAt.clear();
        toolCallNames.clear();
        toolCallAt.clear();
        pendingWakeKeys.clear();
        b.clearAllPendingWakeLeases();
        b.social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
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
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只重放还没结束的回合，已经结束的不重发
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
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

  // sessionEvents 只有测试夹具从桥接里取（断言事件流内容），一并返回。
  return {
    sendToolSucceededSessions, v2TurnStartAt, toolCallNames, pendingSendToolCalls, pendingWakeKeys, turnLeaseNoted, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, trackTurnEvent, pumpMux, rebuildInFlightCollector, sessionEvents, dispatchStats, checkStalledTurns };
}
