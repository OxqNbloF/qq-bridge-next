// QQ 会话到 DSH prompt 的按会话串行投递队列
import { mdToPlain } from '../md-to-plain.js';
import { canonicalV2Key } from '../policy/access.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { rememberModelSources } from '../memory/model-sources.js';
import { modelMessageVisible } from '../gate/model-visibility.js';

// 创建 DSH 投递队列
export function createDshDeliver(b) {
  const promptQueues = new Map();
  // 实际投递 DSH prompt，只经串行队列调用
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!b.isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 出队时复查唤醒：暂停/关闭或模式切换后不调用模型
    const wakeBlocked = () => (opts.wakeReason || opts.wakeReminder) && (b.modeForKey(key) !== 'reserved2' || b.socialV2.paused || b.cfg.socialV2?.enabled === false);
    // 跳过本次唤醒并释放唤醒租约
    const skipWake = () => {
      b.pendingWakeKeys.delete(key);
      b.disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!b.dshReady && opts.schedulerTurnId) return { retry: true };
    if (!b.dshReady) {
      const items = b.queued.get(key) ?? [];
      if (items.length >= b.QUEUE_MAX) {
        items.shift();
        b.log(`队列满（${b.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, wakeReminder: opts.wakeReminder, sourceQqs: [...(opts.sourceQqs ?? [])] });
      b.queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    const startSessionEpoch = b.sessionEpoch;
    const startConvEpoch = b.conversationEpoch?.(key);
    try {
      sessionId = await b.ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        if (b.sessionEpoch !== startSessionEpoch || !b.isSessionAllowedInCurrentMode(key)) {
          return opts.wakeReason || opts.wakeReminder ? skipWake() : { ok: true, skipped: true };
        }
        if (b.conversationEpoch?.(key) !== startConvEpoch && !b.queued?.has(key) && !b.state.sessions[key]) {
          // 主动 /reset 或 retireSession(!preserveQueue) 已清会话，不再复活旧消息
          return opts.wakeReason || opts.wakeReminder ? skipWake() : { ok: true, skipped: true };
        }
        if (opts.schedulerTurnId) return { retry: true };
        b.enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    // 提醒也在建会话后生成，避免同策略重建轮换 token 后发送旧令牌。
    if (opts.wakeReminder) {
      if (wakeBlocked()) return skipWake();
      promptText = b.buildWakeReminderPromptV2(key);
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // 建会话后再构造：令牌可能轮换，队列可能有新消息
      wakeState = b.getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = b.buildWakePromptV2(key, opts.wakeReason, { includeMemory: false });
      wakeSnapshot = b.buildWakeSnapshotV2(key);
      const request = b.turnEngine.activeRequest(key);
      if (request && request.turnId === opts.schedulerTurnId) request.payload.sourceQqs = [...new Set([
        ...(request.payload.sourceQqs ?? []),
        ...wakeState.unread.filter(message => !wakeSnapshot || message.seq <= wakeSnapshot.readThroughSeq).map(message => message.userId).filter(Boolean),
      ])];
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已内联，无需重查；partial=true 时传 afterSeq=readThroughSeq 续读；收尾传 throughSeq=readThroughSeq（本地 seq，非 messageId）。`;
      }
    }
    const mode = b.modeForKey(key);
    if (!opts.wakeReminder && key.startsWith('group:') && !promptText.includes('【群成员】')) {
      const roster = b.renderIdentityRoster(key, { exposeQq: b.cfg.identity?.exposeQqInPrompt === true });
      if (roster) promptText += `\n\n【群成员】\n${roster}`;
    }
    if (!opts.skipMemory && !opts.wakeReminder) {
      const memory = b.buildModeMemory(key);
      if (memory) promptText += `\n\n${memory}`;
    }
    const imageParts = Array.isArray(opts.media) && opts.media.length > 0 ? await b.resolveMediaList(opts.media) : [];
    // 图片读好之后再把这次回复标记成退场
    if (!b.isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    // 统一刷新预构建的令牌行；队列和媒体等待期间可能发生同策略重建。
    const token = b.socialV2.conversations.get(canonicalV2Key(key) ?? key)?.agentToken;
    const text = b.withContextPreamble(promptText, key);
    const content = [{ type: 'text', text: token
      ? text.replace(/【会话令牌】[ \t]*[a-f0-9]{32,48}\b/g, `【会话令牌】${token}`) : text }, ...imageParts];
    if (!opts.schedulerTurnId) b.bindShadowTurn?.(key, sessionId);
    const cursor = b.deliveryCursors?.get(sessionId);
    if (opts.schedulerTurnId && !b.turnEngine.bind(key, opts.schedulerTurnId, sessionId, Math.max(cursor?.deliveredSeq ?? -1, cursor?.inflightSeq ?? -1))) return { ok: true, skipped: true };
    const silentId = opts.silent ? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : null;
    if (silentId) b.social.silentTurns.set(sessionId, [...(b.social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
    const rollbackSilent = () => {
      if (!silentId) return;
      const next = (b.social.silentTurns.get(sessionId) ?? []).filter((item) => item.id !== silentId);
      if (next.length) b.social.silentTurns.set(sessionId, next);
      else b.social.silentTurns.delete(sessionId);
    };
    if (opts.farewell) b.social.exitingSessions.add(sessionId);
    let accepted;
    try {
      const targetKey = canonicalV2Key(key) ?? key;
      const sourceState = b.socialV2.conversations.get(targetKey);
      const visibleWindow = [
        ...(sourceState?.recentMessages ?? []), ...(sourceState?.unread ?? []),
        ...(b.social.recentMessages?.get(key) ?? []),
      ].filter((m) => modelMessageVisible(b, targetKey, m));
      rememberModelSources(b, key, visibleWindow, [
        ...(opts.sourceQqs ?? []), ...(b.turnEngine?.activeRequest(key)?.payload.sourceQqs ?? []),
      ]);
      accepted = await b.api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      rollbackSilent();
      if (opts.farewell) b.social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      rollbackSilent();
      if (opts.farewell) b.social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = b.shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await b.reportTurnFailure(key, 'error', { message: errText }, !opts.silent);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && b.isCurrentSession(key, sessionId)
        && b.socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // 服务器收下不等于确认看过；旧的记录位置不能把新消息划掉
      b.noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && b.modeForKey(key) !== 'reserved2') {
      if (opts.farewell) b.social.exitingSessions.delete(sessionId);
      await b.auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      b.social.exitingSessions.delete(sessionId);
    }
    if (accepted.result.value.command) rollbackSilent();
    // command=true：斜杠命令已回结果，调用方别再 ack
    return { ok: true, command: Boolean(accepted.result.value.command), sessionId };
  }

  // 每会话串行投递，保证 turn 完成顺序与提交一致
  function deliverPrompt(key, promptText, opts = {}) {
    if (!opts.schedulerTurnId && b.schedulerEnabled?.(key)) return b.schedulePrompt(key, promptText, opts);
    if (!opts.schedulerTurnId) b.observeScheduledPrompt?.(key, promptText, opts);
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  // 取出队首项投递，完成后继续下一项
  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  // 清空某会话队列并让待投递项失败
  function drainPromptQueue(key, errorMsg) {
    b.cancelScheduledTurns?.(key, errorMsg);
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  // 清空所有会话队列并让待投递项失败
  function drainAllPromptQueues(errorMsg) {
    b.cancelAllScheduledTurns?.(errorMsg);
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  return {
    promptQueues, deliverPromptNow, deliverPrompt, processPromptQueue, drainPromptQueue, drainAllPromptQueues };
}
