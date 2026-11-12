// DSH 挂起的提问/审批：登记、超时取消、QQ 内作答

// 创建挂起提问/审批处理器
export function createPendingQuestions(b) {
  // 取消挂起的提问或审批，并回执 DSH
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await b.withTimeout(b.api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        b.log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await b.withTimeout(b.api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        b.log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      b.log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起项；返回 true 表示消息已被消费
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      // 答案是权威回执，只认 owner；非 owner 不吞消息
      if (!isOwner) return false;
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await b.api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        b.log(`已回答提问 (${key}):`, receipt);
        // 回执成功且仍是同一挂起项才移除
        if (b.pending.get(key) === p) b.pending.delete(key);
      } catch (error) {
        b.log('回答问题失败（保留挂起以便重试）:', error.message);
        await b.sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await b.sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of b.APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of b.REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await b.sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await b.api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        b.log(`已处理审批 (${key}): ${outcome}`, receipt);
        await b.sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 回执成功且仍是同一挂起项才移除
        if (b.pending.get(key) === p) b.pending.delete(key);
      } catch (error) {
        b.log('处理审批失败（保留挂起以便重试）:', error.message);
        await b.sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 登记挂起项，替换旧项并设超时
  async function registerPending(key, entry) {
    const existing = b.pending.get(key);
    if (existing) {
      b.clearTimeout(existing.timer);
      b.pending.delete(key);
      b.log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = b.setTimeout(() => {
      if (b.pending.get(key) === entry) {
        b.pending.delete(key);
        b.log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        b.sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, b.cfg.questionTimeoutMs);
    entry.timer = timer;
    b.pending.set(key, entry);
  }

  return { cancelPendingEntry, handlePendingAnswer, registerPending };
}
