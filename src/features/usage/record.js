// 把会话事件和快照交给 token 账本，用来算用量

export function createUsageRecorder(b) {
  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();

  // 记住这个会话现在用的是哪个模型
  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 把一条会话事件记进账本；出错也不能影响收发 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      b.tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      b.log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /** 处理会话开场快照：补上历史总用量和每轮花费 */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      b.tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? b.nominalModel(),
        provider: known?.provider ?? b.cfg.dsh?.provider
      });
      b.tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      b.rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      b.log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  return { rememberModel, recordSessionUsage, recordSessionSnapshot, sessionModels };
}
