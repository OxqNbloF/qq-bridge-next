// 二代仿真唤醒简报的构建与投递
import { modelMessageVisible, modelHistoryState } from '../../gate/model-visibility.js';
import { truncateText } from '../../md-to-plain.js';
import { getModeAdapter } from '../../modes/registry.js';
import { isRateLimitExemptReason } from '../../scheduler/trigger.js';

// describeAge 等须经 b 传入，保证与消息同一 realm
export function createWakePromptV2(b) {
  /** 首次唤醒的初始提示段，超长截断；未配置返回空串 */
  function formatInitialPromptV2(key) {
    const entry = b.getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = b.initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  // 构建完整唤醒简报
  function buildWakePromptV2(key, reason, { includeMemory = true } = {}) {
    const roleState = b.readRoleState();
    const rolePick = b.roleForWake(key);
    if (roleState.role) b.log(`[role] 唤醒提示词：${rolePick.full ? `全量角色卡（${rolePick.text.length} 字符）` : '一行提醒'}「${roleState.role}」`);
    const st = b.getSocialV2State(key);
    const triggeredSeq = b.wakeReasonSeq(reason);
    // context 约束历史；仅正在触发本回合的单条输入可例外，不能恢复整个 unread。
    let currentInput = triggeredSeq ? st.unread.find(message => message.seq === triggeredSeq)
      : reason === 'bootstrap' ? st.unread.at(-1) : null;
    if (!currentInput || modelMessageVisible(b, key, currentInput) || currentInput.isSelf) currentInput = null;
    if (currentInput && b.cfg.architecture?.gateV2) {
      const [kind, id] = key.split(':');
      const decision = b.gateDecide({ kind, id: Number(id), qq: currentInput.userId });
      if (!decision.allowed || !decision.flags.respond) currentInput = null;
      else if ((currentInput.sourceQqs ?? []).some(qq => String(qq) !== String(currentInput.userId)
        && !modelMessageVisible(b, key, { userId: qq }))) {
        // 当前输入例外仅属于发送者，不能顺带恢复被引用作者的历史正文。
        // 旧记录缺 plain 时不回退 text：其中可能已经混入受限引用。
        currentInput = { ...currentInput, text: String(currentInput.plain ?? '') };
      }
    }
    let history = modelHistoryState(b, key, st);
    if (b.cfg.identity?.exposeQqInPrompt !== true && Array.isArray(history.wakeConfig?.triggers?.speakerIds) && history.wakeConfig.triggers.speakerIds.length) {
      history = {
        ...history,
        wakeConfig: {
          ...history.wakeConfig,
          triggers: {
            ...history.wakeConfig.triggers,
            speakerIds: history.wakeConfig.triggers.speakerIds.map((qq) => b.identityDisplayName?.(String(qq), key.startsWith('group:') ? key.slice(6) : undefined) || '群友'),
          },
        },
      };
    }
    return getModeAdapter('reserved2').buildPrompt({ key, reason, state: history, roleState, rolePick,
      currentInput,
      identity: b.selfIdentityTextV2(), config: b.cfg.socialV2, stickers: b.stickerEntries,
      memoryText: includeMemory ? b.getMemoryContext(key, st) : '',
      roster: key.startsWith('group:') ? b.renderIdentityRoster(key, { exposeQq: b.cfg.identity?.exposeQqInPrompt === true }) : '',
      participation: b.formatParticipationV2(st, key), replyTiming: b.replyTimingV2(st, key), timeSense: b.buildTimeSenseLine(st, key),
      initialPrompt: reason === 'bootstrap' ? formatInitialPromptV2(key) : '', triggeredSeq,
      triggeredMessage: triggeredSeq ? b.findV2MessageBySeq(history, triggeredSeq) ?? currentInput : null,
      now: Date.now(), describeAge: b.describeAge, sanitize: b.sanitizeUntrustedText,
    });
  }

  // 构建同回合的收尾提醒简报
  function buildWakeReminderPromptV2(key) {
    const roleState = b.readRoleState();
    // 同回合收尾提醒不再重复角色卡
    const roleLine = roleState.role
      ? `【当前角色】${roleState.role}（继续按角色卡说话）\n\n`
      : '';
    const identityLine = b.selfIdentityTextV2();
    const st = b.getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(b.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  // 限频并投递唤醒简报，忙时暂存
  function sendWakePromptV2(key, reason, opts = {}) {
    if (b.schedulerEnabled?.(key)) return b.scheduleWakeTurn(key, reason);
    return executeWakePromptV2(key, reason, opts);
  }

  async function executeWakePromptV2(key, reason, opts = {}) {
    if (b.cfg.socialV2?.enabled === false) return { ok: true, skipped: true };
    if (b.modeForKey(key) !== 'reserved2' || b.socialV2.paused) return { ok: true, skipped: true };
    if (!b.isSessionAllowedInCurrentMode(key)) {
      b.log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return { ok: true, skipped: true };
    }
    const st = b.getSocialV2State(key);
    const runtime = b.schedulerRuntime?.(key, st) ?? st;
    // 会话忙时不投递新唤醒，先暂存原因
    if (!opts.schedulerTurnId && b.isConversationBusyV2(key, st)) {
      if (!Array.isArray(runtime.pendingWakeReasons)) runtime.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!runtime.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        runtime.pendingWakeReasons.push({ reason, seq });
        // 暂存队列最多 20 条
        if (runtime.pendingWakeReasons.length > 20) runtime.pendingWakeReasons.splice(0, runtime.pendingWakeReasons.length - 20);
      }
      b.log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${b.busyReasonV2(key, st)}）`);
      return;
    }
    // 超限频时延后重试，不能直接丢弃，否则会话卡在静默；定向唤醒（@/私聊/追问/回复等）不受限流约束
    const now = Date.now();
    const maxPerMinute = Number(b.cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(b.cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    const rateLimitExempt = isRateLimitExemptReason(reason);
    if (!opts.schedulerTurnId && !rateLimitExempt && ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次最多等 60s，避免错过中途可用窗口；已有重试定时器时按优先级升级重试原因
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      const reasonRank = (r) => (b.isDirectedWakeReason(r) ? 3 : b.isTimerWakeReason(r) ? 2 : 1);
      if (!runtime.rateLimitRetryReason || reasonRank(reason) >= reasonRank(runtime.rateLimitRetryReason)) {
        runtime.rateLimitRetryReason = reason;
      }
      if (!runtime.rateLimitRetryTimer) {
        runtime.rateLimitRetryTimer = b.setTimeout(() => {
          runtime.rateLimitRetryTimer = null;
          const retryReason = runtime.rateLimitRetryReason || reason;
          runtime.rateLimitRetryReason = null;
          // 重试前确认消息仍未处理，定时器类原因不查
          if (!b.isTimerWakeReason(retryReason) && !b.isDirectedWakeReason(retryReason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            b.log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${retryReason}）`);
            return;
          }
          void sendWakePromptV2(key, retryReason, { isRateLimitRetry: true }).catch((error) => b.log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        runtime.rateLimitRetryTimer.unref?.();
      }
      const sourceLabel = opts.isRateLimitRetry ? '限流重试' : '触发';
      b.log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${runtime.rateLimitRetryReason}，来源=${sourceLabel}，计数=${recentMinute}/${maxPerMinute}/分 ${recentHour}/${maxPerHour}/时）`);
      return;
    }
    // 只有真正唤醒才重置观察，跳过/忙时保留进度
    if (runtime.rateLimitRetryTimer) {
      (b.clearSchedulerTimer ?? b.clearTimeout)(runtime.rateLimitRetryTimer);
      runtime.rateLimitRetryTimer = null;
    }
    runtime.rateLimitRetryReason = null;
    const prevPreSleepSatisfiedAt = st.preSleepWaitSatisfiedAt;
    const prevPreSleepObservedAt = st.preSleepWaitObservedAt;
    const prevPreSleepAccumMs = st.preSleepWaitAccumMs;
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    b.cancelReplyCheckV2(key); // 本次唤醒已接管，清掉排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 清除有限潜水定时器与 sleepUntil，防重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const prevLastWakeAt = st.wakeConfig.lastWakeAt;
    const prevWakeCount = st.wakeConfig.wakeCount;
    const prevLastWakeReason = st.lastWakeReason;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (runtime.sleepTimer) {
      (b.clearSchedulerTimer ?? b.clearTimeout)(runtime.sleepTimer);
      runtime.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    b.saveSocialV2State();
    // 唤醒提示词推迟到 deliverPromptNow 建会话后再唯一构造一次，避免重复跑角色计数/记忆检索/快照
    b.log(`[reserved2] 唤醒 ${key}（${reason}）`);
    // 投递失败/重试时统一回滚唤醒状态与沉睡前观察进度
    const rollbackWakeState = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      st.wakeConfig.lastWakeAt = prevLastWakeAt;
      st.wakeConfig.wakeCount = prevWakeCount;
      st.lastWakeReason = prevLastWakeReason;
      st.preSleepWaitSatisfiedAt = prevPreSleepSatisfiedAt;
      st.preSleepWaitObservedAt = prevPreSleepObservedAt;
      st.preSleepWaitAccumMs = prevPreSleepAccumMs;
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
      } else {
        st.wakeConfig.sleepUntil = prevSleepUntil;
      }
      b.saveSocialV2State();
      if (hadFiniteSleep) b.setupSleepTimerV2(key);
    };
    try {
      b.pendingWakeKeys.add(key);
      if (!opts.schedulerTurnId) b.armPendingWakeLease(key);
      const result = await b.deliverPrompt(key, '', { ...opts, wakeReason: reason });
      if (result?.retry) {
        b.pendingWakeKeys.delete(key);
        rollbackWakeState();
        return result;
      }
      if (result && result.ok === false) {
        b.pendingWakeKeys.delete(key);
        b.disarmPendingWakeLease(key);
        rollbackWakeState();
        b.log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && (result.queued === true || result.retry === true)) {
        // 只在入队时保留 pendingWakeKeys，否则补投会丢收尾保底
        b.log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
      return result;
    } catch (error) {
      b.pendingWakeKeys.delete(key);
      b.disarmPendingWakeLease(key);
      rollbackWakeState();
      b.log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
      if (opts.schedulerTurnId) throw error;
    }
  }

  return { formatInitialPromptV2, buildWakePromptV2, buildWakeReminderPromptV2, sendWakePromptV2, executeWakePromptV2 };
}
