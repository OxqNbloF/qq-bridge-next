// DSH 挂起的提问/审批：登记、超时取消、QQ 内作答

const DEFAULT_COMPENSATION_DELAYS_MS = [15_000, 45_000, 90_000];
const MAX_COMPENSATIONS = 50;

// 创建挂起提问/审批处理器
export function createPendingQuestions(b) {
  const compensations = new Map();

  function compensationKey(entry) {
    return `${entry?.clientId ?? ''}:${entry?.eventId ?? entry?.rpcId ?? ''}`;
  }

  function resolveEntryKey(entry) {
    return entry?.key ?? b.reverse?.get?.(entry?.sessionId) ?? null;
  }

  function clearCompensation(compKey) {
    const existing = compensations.get(compKey);
    if (existing?.timer) b.clearTimeout(existing.timer);
    compensations.delete(compKey);
  }

  function clearPendingCompensations() {
    for (const item of compensations.values()) {
      if (item?.timer) b.clearTimeout(item.timer);
    }
    compensations.clear();
    persistCompensations();
  }

  // 补偿队列随会话映射落盘（字段只增不改，schema 不变）；重启后由 restorePendingCompensations 续补。
  function persistCompensations() {
    if (!b.state || typeof b.state !== 'object' || typeof b.saveState !== 'function') return;
    const items = [...compensations.values()].map((item) => ({
      compKey: compensationKey(item.entry),
      entry: {
        kind: item.entry.kind, key: item.entry.key ?? null,
        clientId: item.entry.clientId ?? null, eventId: item.entry.eventId ?? null, rpcId: item.entry.rpcId ?? null,
      },
      outcome: item.outcome,
      round: item.round,
      nextAt: item.nextAt,
    }));
    if (items.length) b.state.pendingCompensations = items;
    else delete b.state.pendingCompensations;
    try { b.saveState(); } catch (error) { b.log('⚠️ 撤权补偿队列持久化失败:', error?.message ?? error); }
  }

  // DSH 就绪后调用：恢复重启前未完成的撤权补偿；幂等，重复调用不重复登记。
  function restorePendingCompensations() {
    const saved = Array.isArray(b.state?.pendingCompensations) ? b.state.pendingCompensations : [];
    if (!saved.length) return 0;
    delete b.state.pendingCompensations;
    let restored = 0;
    for (const item of saved) {
      const entry = item?.entry;
      if (!entry || (entry.kind !== 'approval' && entry.kind !== 'question') || !item.outcome) continue;
      const compKey = compensationKey(entry);
      if (compensations.has(compKey)) continue;
      // 重启续补在 DSH 就绪后立即执行，不沿用重启前的剩余延迟。
      const timer = b.setTimeout(async () => {
        const current = compensations.get(compKey);
        if (!current) return;
        if (b.shutdownRequested) return;
        const res = await sendCancelReceipt(entry, current.outcome, 1);
        if (res.ok) {
          compensations.delete(compKey);
          persistCompensations();
          b.log(`✅ 挂起撤权补偿回执成功（重启续补） (${entry.key ?? '-'} / ${entry.eventId ?? entry.rpcId ?? '-'})`);
          b.appendActivity?.(`✅ 撤权回执补偿成功（重启续补） ${entry.key ?? 'unknown'} (${entry.eventId ?? entry.rpcId ?? '-'})`);
          return;
        }
        scheduleCompensation(compKey, entry, current.outcome, current.round + 1, res.error);
      }, 0);
      timer?.unref?.();
      compensations.set(compKey, { entry, outcome: item.outcome, timer, round: Number(item.round) || 0, nextAt: Date.now() });
      restored += 1;
    }
    persistCompensations();
    if (restored) {
      b.log(`已恢复 ${restored} 条重启前未完成的撤权补偿`);
      b.appendActivity?.(`✅ 撤权补偿重启续补：恢复 ${restored} 条`);
    }
    return restored;
  }

  async function sendCancelReceipt(entry, outcome, attempts) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await b.withTimeout(b.api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome
        }), 5000, '取消挂起回执');
        return { ok: true };
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, error: lastError };
  }

  function scheduleCompensation(compKey, entry, outcome, round, lastError) {
    const delays = Array.isArray(b.cfg?.pendingCancelRetryDelaysMs)
      ? b.cfg.pendingCancelRetryDelaysMs
      : DEFAULT_COMPENSATION_DELAYS_MS;
    const isApproval = entry.kind === 'approval';
    const label = isApproval ? '挂起审批拒绝回执' : '挂起提问空答案回执';
    const targetKey = resolveEntryKey(entry);
    const targetId = entry.eventId ?? entry.rpcId ?? '-';
    const errMsg = lastError?.message ?? String(lastError);
    if (b.shutdownRequested || round >= delays.length) {
      compensations.delete(compKey);
      persistCompensations();
      b.log(`⚠️ 挂起撤权补偿重试已耗尽 (${targetKey ?? '-'} / ${targetId}): ${errMsg}`);
      b.appendActivity?.(`❌ 撤权回执补偿耗尽 ${targetKey ?? 'unknown'} (${label} ${targetId}): ${errMsg}`);
      return;
    }
    clearCompensation(compKey);
    if (compensations.size >= MAX_COMPENSATIONS) {
      const oldestKey = compensations.keys().next().value;
      clearCompensation(oldestKey);
    }
    const nextAt = Date.now() + delays[round];
    const timer = b.setTimeout(async () => {
      const current = compensations.get(compKey);
      if (!current) return;
      // 停机时不发起新回执也不重排定时器；条目保留落盘，重启后由 restore 续补。
      if (b.shutdownRequested) return;
      const res = await sendCancelReceipt(entry, outcome, 1);
      if (res.ok) {
        compensations.delete(compKey);
        persistCompensations();
        b.log(`✅ 挂起撤权补偿回执成功 (${targetKey ?? '-'} / ${targetId})`);
        b.appendActivity?.(`✅ 撤权回执补偿成功 ${targetKey ?? 'unknown'} (${label} ${targetId})`);
        return;
      }
      scheduleCompensation(compKey, entry, outcome, round + 1, res.error);
    }, delays[round]);
    timer?.unref?.();
    compensations.set(compKey, { entry, outcome, timer, round, nextAt });
    persistCompensations();
  }

  // 取消挂起的提问或审批，并回执 DSH；最终失败时告警并进入有界延迟补偿
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    const isApproval = entry.kind === 'approval';
    const isQuestion = entry.kind === 'question';
    if (!isApproval && !isQuestion) return;
    const outcome = isApproval ? { kind: 'result', value: 'rejected' } : { kind: 'result', value: { answers: [] } };
    const compKey = compensationKey(entry);
    const res = await sendCancelReceipt(entry, outcome, 2);
    if (res.ok) {
      const hadCompensation = compensations.has(compKey);
      clearCompensation(compKey);
      if (hadCompensation) persistCompensations();
      b.log(isApproval ? `已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}` : `已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      return;
    }
    const msg = res.error?.message ?? String(res.error);
    const targetKey = resolveEntryKey(entry);
    const targetId = entry.eventId ?? entry.rpcId ?? '-';
    const label = isApproval ? '挂起审批拒绝回执' : '挂起提问空答案回执';
    b.log('取消挂起请求回执失败:', msg);
    b.appendActivity?.(`⚠️ 撤权回执失败 ${targetKey ?? 'unknown'} (${label} ${targetId}): ${msg}`);
    if (b.cfg?.ownerQQ && b.sendToQQ) {
      void Promise.resolve(b.sendToQQ(
        `private:${b.cfg.ownerQQ}`,
        `⚠️ 挂起请求撤权回执失败（${targetKey ?? '会话未知'} / ${label} ${targetId}），系统将自动补偿重试：${msg}`
      )).catch(() => {});
    }
    scheduleCompensation(compKey, entry, outcome, 0, res.error);
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
    entry.key ??= key;
    const existing = b.pending.get(key);
    if (existing) {
      b.clearTimeout(existing.timer);
      b.pending.delete(key);
      b.log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry({ ...existing, key }).catch(() => {});
    }
    const timer = b.setTimeout(() => {
      if (b.pending.get(key) === entry) {
        b.pending.delete(key);
        b.log(`挂起请求超时 (${key})`);
        cancelPendingEntry({ ...entry, key }).catch(() => {});
        b.sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, b.cfg.questionTimeoutMs);
    entry.timer = timer;
    b.pending.set(key, entry);
  }

  return { cancelPendingEntry, handlePendingAnswer, registerPending, clearPendingCompensations, restorePendingCompensations, getPendingCompensationCount: () => compensations.size };
}
