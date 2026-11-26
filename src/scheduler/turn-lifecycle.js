// 旧模式的回合收尾适配；事件泵只交付事件，不解释模式业务。
import { getModeAdapter } from '../modes/registry.js';
import { mdToPlain } from '../md-to-plain.js';
import { isSilentMarker, SILENT_MARKER } from '../policy/audit.js';
import { SENSITIVE_RE } from '../sensitive.js';

export function createTurnLifecycle(b, { v2TurnStartAt, lastEventAt, turnLeaseNoted, sendToolSucceededSessions, pendingSendToolCalls, toolCallNames, toolCallAt, pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, dispatch }) {
  async function handleEndedTurn(key, sessionId, ended) {
    // 醒来什么都没做就累计一次，次数多了重置唤醒配置
    const silentQueueNow = b.social.silentTurns.get(sessionId) ?? [];
    const isSilentTurn = silentQueueNow.length > 0;
    if (key && b.modeForKey(key) === 'reserved2' && !isSilentTurn) {
      const st = b.getSocialV2State(key);
      const turnStart = v2TurnStartAt.get(sessionId) ?? 0;
      const sendToolHit = sendToolSucceededSessions.has(sessionId);
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
    v2TurnStartAt.delete(sessionId);
    lastEventAt.delete(sessionId);
    b.collectors.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    const sendToolSucceeded = sendToolSucceededSessions.has(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    toolCallNames.delete(sessionId);
    toolCallAt.delete(sessionId);
    // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
    const isFarewell = b.social.exitingSessions.has(sessionId);
    if (isFarewell) b.social.exitingSessions.delete(sessionId);
    // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
    // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
    const silentQueue = b.social.silentTurns.get(sessionId) ?? [];
    const silentNow = Date.now();
    while (silentQueue.length && silentNow - silentQueue[0].ts > b.SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
    if (silentQueue.length > 0) {
      silentQueue.shift();
      if (silentQueue.length > 0) b.social.silentTurns.set(sessionId, silentQueue);
      else b.social.silentTurns.delete(sessionId);
      b.log(`摘要投喂 turn 结束，静默 (${key})`);
      b.settleScheduledTurn?.(key, sessionId, ended.turn, ended.reason.kind);
      return;
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
          if (!b.schedulerEnabled?.(key)) b.armPendingWakeLease(key);
          b.deliverPrompt(key, '', { wakeReminder: true }).then((result) => {
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
    await dispatch(sessionId, true, async () => {
      // 排队期间会话可能被 /reset、重建或退役：旧会话的回复不再发到这个群。
      try {
        if (!b.isCurrentSession(key, sessionId)) { b.log(`会话 ${key} 已更换，丢弃旧会话 ${sessionId} 的回合发送`); return undefined; }
        return await deliverEndedTurn(key, ended, isFarewell, sendToolSucceeded);
      } finally { b.settleScheduledTurn?.(key, sessionId, ended.turn, ended.reason.kind); b.armSocialTimer?.(key); }
    }, () => b.settleScheduledTurn?.(key, sessionId, ended.turn, 'dispatch-dropped'));
  }

  // 统一收尾退场状态，消除各退出分支的重复状态清理
  function finishFarewell(key, isFarewell, reason, { onlyIfExiting = true } = {}) {
    if (!isFarewell) return;
    const st = b.socialState(key);
    if (!onlyIfExiting || st.phase === 'exiting') {
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      b.log(`社交模式：${key} ${reason}`);
    }
  }

  // 回合结束后把回复发到 QQ
  async function deliverEndedTurn(key, ended, isFarewell, sendToolSucceeded) {
    const adapter = getModeAdapter(b.modeForKey(key));
    if (!adapter) return;
    const intent = adapter.onTurnEnd({ farewell: isFarewell }, ended);
    if (ended.reason.kind === 'completed' && ended.text.trim()) {
      const plain = mdToPlain(ended.text);
      // 只有格式没有文字就当没回复
      if (!plain.trim()) {
        b.log(`agent 回复为空（仅格式/空白）(${key})`);
        finishFarewell(key, isFarewell, '空退场回合，回到观望');
        return;
      }
      // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
      if (isSilentMarker(plain)) {
        b.log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
        finishFarewell(key, isFarewell, '退场选择静默，回到观望');
        return;
      }
      // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
      if (sendToolSucceeded) {
        b.log(`工具已发送消息，跳过自动转发 (${key})`);
        finishFarewell(key, isFarewell, '工具发送后退场完成，回到观望');
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
        finishFarewell(key, isFarewell, '退场发言被拦截，回到观望');
        return;
      }
      // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
      if (intent?.mode === 'timeline' && b.isSocialEnabled(key)) {
        if (b.shouldBlockSilentReply(key)) {
          b.log(`静默模式，拦截在途回复 (${key})`);
          b.appendActivity(`${key} 静默模式，拦截在途回复`);
          finishFarewell(key, isFarewell, '静默模式下退场回合被拦截，回到观望');
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
          finishFarewell(key, true, '退场发言完成，进入观望', { onlyIfExiting: false });
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
      } else if (adapter.sendPolicy.mode === 'tools-only') {
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
      await b.reportTurnFailure(key, 'error', ended.reason.error ?? (ended.reason.message ? { message: ended.reason.message } : undefined));
      finishFarewell(key, isFarewell, '退场发言出错，回到观望');
    } else if (ended.reason.kind === 'aborted') {
      await b.reportTurnFailure(key, 'aborted');
      finishFarewell(key, isFarewell, '退场发言中止，回到观望');
    } else if (!ended.text.trim()) {
      // completed 但没文本（纯工具调用回合）
      b.log(`回合完成但无文本 (${key})`);
      finishFarewell(key, isFarewell, '退场回合无文本，回到观望');
    }
  }

  return { handleEndedTurn };
}
