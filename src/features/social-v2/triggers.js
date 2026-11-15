import { modelMessageVisible, modelStateKey } from '../../gate/model-visibility.js';
import { evaluateTrigger } from '../../scheduler/trigger.js';
// 判断一条消息要不要叫醒 AI，以及算「已经读到哪里了」
// 只有真的给 AI 看过的消息，才算它读过

export function createTriggersV2(b) {
  // 看这条消息要不要叫醒 AI，并说出是什么原因
  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    return evaluateTrigger({
      kind, triggers: st.wakeConfig?.triggers ?? {}, event, plainContent, quoteTargetIsSelf,
      names: [...new Set([b.selfNickname, ...b.identityAliases(String(event?.self_id ?? ''), key.startsWith('group:') ? key.slice(6) : null)].filter(Boolean))],
      directed: b.isDirectedAtAi(plainContent), random: Math.random(),
    });
  }

  // 只有真的给模型看过的消息才算读过；这个记录只在内存里，重启后要重新读
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // 当前隐藏的消息可安全跳过，但不记成展示回执；策略恢复后须重新判断。
    // 可见消息仍必须确实展示，不能越过未展示的可见缺口。
    const key = modelStateKey(b, st);
    const hidden = new Set(st.unread.filter((message) => !modelMessageVisible(b, key, message)).map((message) => message.seq));
    const reachable = (seq) => seen.has(seq) || hidden.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  // 记下这些消息已经给模型看过了
  function noteModelMessagesV2(st, messages) {
    // 只记还在未读列表里的消息，历史消息和自己发的不记
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  // 检查模型要求把已读位置推进到哪儿
  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) {
      return isAgent && b.cfg?.architecture?.gateV2 ? readThroughSeqV2(st) : null;
    }
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  // 把读到指定位置之前未读的消息清掉
  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // 控制台和老预设不带位置时就把未读全清掉
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  return { evaluateWakeTriggerV2, readThroughSeqV2, noteModelMessagesV2, requestedReadThroughSeqV2, acknowledgeMessagesV2 };
}
