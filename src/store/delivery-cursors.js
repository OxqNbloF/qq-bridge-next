// 记录回复发到哪了（已发位置、进行中的回合）与补发
import { mdToPlain } from '../md-to-plain.js';
import { isSendToolName, isSilentMarker } from '../policy/audit.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';

// 创建「回复发到哪了」的记录器
export function createDeliveryCursors(b) {
  // 本模块持有的内存状态
  const deliveryCursors = new Map(); // sessionId -> 交付与在途的 turn/seq
  const pendingDeliveryReplays = new Map(); // sessionId -> records[]
  const deliveryLocks = new Map(); // sessionId -> Promise，快照补发按会话串行
  // 把事件 seq 转成数字，无效返回 -1
  const eventSeq = (value) => {
    if (value === null || value === undefined || value === '') return -1;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -1;
  };

    /** 同一个会话的补发排成一队，后一个能读到新位置 */
  function runWithDeliveryLock(sessionId, task) {
    const previous = deliveryLocks.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    let tail;
    tail = run.catch(() => {}).finally(() => {
      if (deliveryLocks.get(sessionId) === tail) deliveryLocks.delete(sessionId);
    });
    deliveryLocks.set(sessionId, tail);
    return run;
  }

    // 从硬盘文件读出这些记录
  function loadDeliveryCursors() {
    const raw = readJsonSafe(b.DELIVERY_CURSOR_FILE, null);
    const sessions = raw?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return;
    for (const [sessionId, value] of Object.entries(sessions)) {
      if (!sessionId || !value || typeof value !== 'object') continue;
      const deliveredTurn = typeof value.deliveredTurn === 'string' ? value.deliveredTurn : '';
      const inflightTurn = typeof value.inflightTurn === 'string' ? value.inflightTurn : '';
      const deliveredSeq = eventSeq(value.deliveredSeq);
      const inflightSeq = eventSeq(value.inflightSeq);
      if (deliveredTurn || inflightTurn || deliveredSeq >= 0 || inflightSeq >= 0) {
        deliveryCursors.set(sessionId, { deliveredTurn, deliveredSeq, inflightTurn, inflightSeq });
      }
    }
  }

    // 把记录写到硬盘文件
  function saveDeliveryCursors() {
    const sessions = {};
    for (const [sessionId, value] of deliveryCursors) {
      if (!b.reverse.has(sessionId)) continue;
      if (!value?.deliveredTurn && !value?.inflightTurn && !(value?.deliveredSeq >= 0) && !(value?.inflightSeq >= 0)) continue;
      sessions[sessionId] = {
        ...(value.deliveredTurn ? { deliveredTurn: value.deliveredTurn } : {}),
        ...(value.deliveredSeq >= 0 ? { deliveredSeq: value.deliveredSeq } : {}),
        ...(value.inflightTurn ? { inflightTurn: value.inflightTurn } : {}),
        ...(value.inflightSeq >= 0 ? { inflightSeq: value.inflightSeq } : {})
      };
    }
    try {
      atomicWriteJson(b.DELIVERY_CURSOR_FILE, { version: 1, sessions });
    } catch (error) {
            // 写失败最多导致重复补发一次，不影响主流程
      b.log(`交付游标写入失败（重连补发可能重复一次）：${error?.message ?? error}`);
    }
  }

  // 记录回合开始（在途）
  function markTurnStarted(sessionId, turn, seq) {
    if (!sessionId || !turn) return;
    const value = String(turn);
    const seqValue = eventSeq(seq);
    const current = deliveryCursors.get(sessionId) ?? { deliveredTurn: '', deliveredSeq: -1, inflightTurn: '', inflightSeq: -1 };
    if (current.inflightTurn === value && current.inflightSeq === seqValue) return;
    current.inflightTurn = value;
    if (seqValue >= 0) current.inflightSeq = seqValue;
    deliveryCursors.set(sessionId, current);
    saveDeliveryCursors();
  }

    // 记下这个回合已发出，把位置往后推
  function markTurnDelivered(sessionId, turn, seq) {
    if (!sessionId || !turn) return;
    const value = String(turn);
    const seqValue = eventSeq(seq);
    const current = deliveryCursors.get(sessionId) ?? { deliveredTurn: '', deliveredSeq: -1, inflightTurn: '', inflightSeq: -1 };
    const currentSeq = eventSeq(current.deliveredSeq);
    const nextSeq = Math.max(currentSeq, seqValue);
        // 位置只能往前取，迟到的补发不能让它后退
    const advanceTurn = currentSeq < 0 || seqValue >= currentSeq;
    const changed = (advanceTurn && current.deliveredTurn !== value)
      || nextSeq !== currentSeq
      || (current.inflightTurn === value);
    if (!changed) return;
    if (advanceTurn) current.deliveredTurn = value;
    current.deliveredSeq = nextSeq;
    if (current.inflightTurn === value) current.inflightTurn = '';
    deliveryCursors.set(sessionId, current);
    saveDeliveryCursors();
  }

    // 删掉某个会话的「发到哪了」记录
  function forgetDeliveryCursor(sessionId) {
    if (!sessionId || !deliveryCursors.delete(sessionId)) return;
    saveDeliveryCursors();
  }

  /** 由快照重建已完成回合；已用 QQ 工具发送的不补发 */
  function completedTurnsFromRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return [];
    const turns = [];
    const callNames = new Map();
    let current = null;
    for (const entry of records) {
      const event = entry?.type === 'event' ? entry.event : entry;
      if (!event || typeof event !== 'object') continue;
      const seq = eventSeq(entry?.seq ?? event.seq);
      if (event.type === 'turn/start') {
        const turn = String(event.data?.turn ?? '');
        current = turn
          ? { turn, text: '', reasonKind: '', sendToolSucceeded: false, maxSeq: seq, endSeq: -1 }
          : null;
        if (current) turns.push(current);
        callNames.clear();
        continue;
      }
      if (!current) continue;
      if (seq >= 0) current.maxSeq = Math.max(current.maxSeq, seq);
      if (event.type === 'assistant/message') {
        if (String(event.data?.turn ?? '') !== current.turn) continue;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') current.text += block.text;
        }
      } else if (event.type === 'tool/call') {
        const callId = event.data?.callId;
        if (callId != null) callNames.set(String(callId), String(event.data?.name ?? ''));
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId;
        const toolName = callId != null ? callNames.get(String(callId)) ?? '' : '';
        const resultBlock = event.data?.message?.content?.[0];
        const isError = event.data?.message?.isError === true || resultBlock?.isError === true;
        if (!isError && isSendToolName(toolName)) current.sendToolSucceeded = true;
        if (callId != null) callNames.delete(String(callId));
      } else if (event.type === 'turn/end') {
        if (String(event.data?.turn ?? '') !== current.turn) continue;
        current.reasonKind = String(event.data?.reason?.kind ?? '');
        current.endSeq = Math.max(current.maxSeq, seq);
        current = null;
        callNames.clear();
      }
    }
    return turns.filter((turn) => turn.reasonKind);
  }

  /** 补发断线期间完成的回复；仅 chat/closed-agent */
  async function replayCompletedTurns(sessionId, records) {
    const key = b.reverse.get(sessionId);
    const mode = key ? b.modeForKey(key) : b.currentMode;
    if (mode !== 'chat' && mode !== 'closed-agent') return;
    if (!key || !b.isCurrentSession(key, sessionId)) return;
    const completed = completedTurnsFromRecords(records);
    if (completed.length === 0) return;

    const cursor = deliveryCursors.get(sessionId);
    const watermark = cursor && cursor.deliveredSeq >= 0 ? cursor.deliveredSeq : null;
    const hasAllSeqs = completed.every((turn) => turn.endSeq >= 0);
    let missed = null;
    if (watermark != null && hasAllSeqs) {
            // 先按序号位置判断哪些回合是新的
      missed = completed.filter((turn) => turn.endSeq > watermark);
    } else {
            // 没有序号时退回用回合编号来比对
      if (cursor?.deliveredTurn) {
        const index = completed.findIndex((turn) => turn.turn === cursor.deliveredTurn);
        if (index >= 0) missed = completed.slice(index + 1);
      }
            // 比对点不在范围内时，用没结束的回合保底
      if (missed == null && (cursor?.inflightTurn || cursor?.inflightSeq >= 0)) {
        if (cursor.inflightTurn) {
          const index = completed.findIndex((turn) => turn.turn === cursor.inflightTurn);
          if (index >= 0) missed = completed.slice(index);
        }
        if (!missed && cursor.inflightSeq >= 0 && hasAllSeqs) {
          missed = completed.filter((turn) => turn.endSeq >= cursor.inflightSeq);
        }
      }
    }
    if (missed == null) {
            // 没有比对点时绝不整批重发，只把位置推到末尾
      if (!cursor?.deliveredTurn && watermark == null) {
        const last = completed[completed.length - 1];
        markTurnDelivered(sessionId, last.turn, last.endSeq);
        b.log(`重连快照：初始化 ${key} 的交付游标（跳过窗口内 ${completed.length} 个历史回合）`);
      }
      return;
    }

    for (const turn of missed) {
      if (turn.reasonKind !== 'completed' || !turn.text.trim()) {
        markTurnDelivered(sessionId, turn.turn, turn.endSeq);
        continue;
      }
      const plain = mdToPlain(turn.text);
      if (!plain.trim() || isSilentMarker(plain)) {
        if (isSilentMarker(plain)) b.log(`重连补发跳过 ${key} turn ${turn.turn}：模型选择了静默标记`);
        markTurnDelivered(sessionId, turn.turn, turn.endSeq);
        continue;
      }
      if (turn.sendToolSucceeded) {
        b.log(`重连补发跳过 ${key} turn ${turn.turn}：该回合已通过 MCP 发送工具发出`);
        markTurnDelivered(sessionId, turn.turn, turn.endSeq);
        continue;
      }
      if (b.shouldBlockSilentReply(key)) {
        b.log(`静默模式，重连补发跳过在途回复 (${key})`);
        markTurnDelivered(sessionId, turn.turn, turn.endSeq);
        continue;
      }
      if (b.shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || b.hasKnownTokenFragment(plain))) {
        b.log(`⚠️ 断线期间的回复被安全策略拦截 (${key})，未补发`);
        b.appendActivity(`${key} 断线期间 agent 回复被拦截（疑似敏感信息/会话令牌）`);
        markTurnDelivered(sessionId, turn.turn, turn.endSeq);
        continue;
      }
      b.log(`重连补发断线期间完成的回复 (${key}, turn ${turn.turn}, seq ${turn.endSeq}, ${plain.length} 字)`);
      await b.sendToQQ(key, plain, { ai: true });
      if (!b.lastSendSucceeded(key)) {
        b.log(`重连补发发送失败，保留游标以便下次重连重试 (${key}, turn ${turn.turn})`);
        return;
      }
      b.appendActivity(`${key} 重连补发 agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
      markTurnDelivered(sessionId, turn.turn, turn.endSeq);
    }
  }

  // 处理会话快照，补发未交付的回复
  async function handleSessionSnapshot(sessionId, snapshot) {
    b.recordSessionSnapshot(sessionId, snapshot);
    const records = snapshot?.records;
    if (!b.modeKnown) {
      // 模式未定：先暂存，等 refreshMode 后再判断
      if (Array.isArray(records) && records.length > 0) pendingDeliveryReplays.set(sessionId, records);
      return;
    }
    try {
      await runWithDeliveryLock(sessionId, () => replayCompletedTurns(sessionId, records));
    } catch (error) {
      // 补发失败不能打断 DSH 事件流
      b.log(`重连补发快照失败 ${sessionId}: ${error?.message ?? error}`);
    }
  }

  // 模式确定后补发暂存的快照
  async function replayDeferredDeliveries() {
    if (!b.modeKnown || pendingDeliveryReplays.size === 0) return;
    const pending = [...pendingDeliveryReplays.entries()];
    pendingDeliveryReplays.clear();
    for (const [sessionId, records] of pending) {
      try {
        await runWithDeliveryLock(sessionId, () => replayCompletedTurns(sessionId, records));
      } catch (error) {
        b.log(`暂存快照补发失败 ${sessionId}: ${error?.message ?? error}`);
      }
    }
  }

  return {
    deliveryCursors, pendingDeliveryReplays, deliveryLocks, runWithDeliveryLock, loadDeliveryCursors, saveDeliveryCursors, markTurnStarted, markTurnDelivered, forgetDeliveryCursor, completedTurnsFromRecords, replayCompletedTurns, handleSessionSnapshot, replayDeferredDeliveries };
}
