import { canonicalV2Key } from '../policy/access.js';

// 模型可能从整个最近上下文提炼记忆，不能信任模型自报的来源来绕过成员策略。
export function assertMemoryWriteAllowed(b, key, { state, targetQq, sourceMessageIds } = {}) {
  if (sourceMessageIds !== undefined && (!Array.isArray(sourceMessageIds) || sourceMessageIds.length > 50 || sourceMessageIds.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim() || String(id).length > 128))) {
    throw Object.assign(new Error('记忆来源必须是最多 50 个有效消息号'), { statusCode: 400 });
  }
  if (!b.cfg.architecture?.gateV2) return;
  key = canonicalV2Key(key);
  if (!key) throw Object.assign(new Error('会话 key 非法'), { statusCode: 400 });
  const [kind, id] = key.split(':');
  const st = state ?? b.socialV2?.conversations.get(key);
  const deny = reason => {
    const audit = `[memory] ${key} 写入被拒（${reason}）`;
    b.log?.(audit);
    b.appendActivity?.(audit);
    throw Object.assign(new Error(`成员策略不允许写入记忆（${reason}）`), { statusCode: 403, reason });
  };
  if (sourceMessageIds !== undefined) {
    const known = new Set([...(st?.recentMessages ?? []), ...(st?.unread ?? [])]
      .filter(message => !message.noContext && (message.isSelf || /^[1-9]\d{0,15}$/.test(String(message.userId))))
      .map(message => String(message.messageId ?? '')).filter(Boolean));
    if (sourceMessageIds.some(id => !known.has(String(id)))) deny('source-not-allowed');
  }
  const selfQq = /^[1-9]\d{0,15}$/.test(String(b.selfUserId ?? '')) ? String(b.selfUserId) : '';
  const actors = kind === 'private' ? [id] : [
    ...(st?.modelSourceQqs ?? []),
    ...(b.turnEngine?.activeRequest(key)?.payload.sourceQqs ?? []),
    ...(st?.recentMessages ?? []).filter(message => !message.isSelf).map(message => message.userId),
    ...(st?.unread ?? []).filter(message => !message.isSelf).map(message => message.userId),
  ].filter(qq => !selfQq || String(qq) !== selfQq);
  if (targetQq) actors.push(targetQq);
  if (st?.modelSourcesIncomplete) deny('model-sources-incomplete');
  for (const qq of new Set(actors.filter(Boolean).map(String).filter(qq => /^[1-9]\d{0,15}$/.test(qq)))) {
    const decision = b.gateDecide({ kind, id: Number(id), qq });
    if (!decision.allowed || !decision.flags.memory || decision.reason === 'policy-broken') {
      // 历史硬 deny 来源仍可能在模型上下文里；清理/撤销机制落地前不能直接跳过。
      deny(decision.reason === 'policy-broken' ? 'policy-broken' : (decision.allowed ? 'memory=false' : decision.reason));
    }
  }
}
