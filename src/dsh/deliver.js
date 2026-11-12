// QQ 会话到 DSH prompt 的按会话串行投递队列
import { mdToPlain } from '../md-to-plain.js';
import { canonicalV2Key } from '../policy/access.js';
import { SENSITIVE_RE } from '../sensitive.js';

// 创建 DSH 投递队列
export function createDshDeliver(b) {
  // 本模块持有的内存状态
  const promptQueues = new Map(); // key -> { queue, running }，按会话串行保证顺序
  // 实际投递 DSH prompt，只经串行队列调用
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!b.isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 出队时复查唤醒：暂停/关闭或模式切换后不调用模型
    const wakeBlocked = () => opts.wakeReason && (b.modeForKey(key) !== 'reserved2' || b.socialV2.paused || b.cfg.socialV2?.enabled === false);
    // 跳过本次唤醒并释放唤醒租约
    const skipWake = () => {
      b.pendingWakeKeys.delete(key);
      b.disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!b.dshReady) {
      const items = b.queued.get(key) ?? [];
      if (items.length >= b.QUEUE_MAX) {
        items.shift();
        b.log(`队列满（${b.QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      b.queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await b.ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        b.enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // 建会话后再构造：令牌可能轮换，队列可能有新消息
      wakeState = b.getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = b.buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = b.buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: b.withSlangContext(promptText, key) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await b.resolveMediaList(opts.media);
      content = [{ type: 'text', text: b.withSlangContext(promptText, key) }, ...imageParts];
    }
    // 图片读好之后再把这次回复标记成退场
    if (!b.isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) b.social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await b.api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) b.social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
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
    // command=true：斜杠命令已回结果，调用方别再 ack
    return { ok: true, command: Boolean(accepted.result.value.command) };
  }

  // 每会话串行投递，保证 turn 完成顺序与提交一致
  function deliverPrompt(key, promptText, opts = {}) {
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
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  // 清空所有会话队列并让待投递项失败
  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  return {
    promptQueues, deliverPromptNow, deliverPrompt, processPromptQueue, drainPromptQueue, drainAllPromptQueues };
}
