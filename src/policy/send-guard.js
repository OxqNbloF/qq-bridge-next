// 发送前的最后检查：确认这条消息还允许发出去
import { SENSITIVE_RE } from '../sensitive.js';

const validQq = qq => /^[1-9]\d{0,15}$/.test(String(qq ?? ''));

export function toolSources(b, key) {
  const st = b.socialV2?.conversations.get(key);
  const selfQq = validQq(b.selfUserId) ? String(b.selfUserId) : '';
  const actors = new Set();
  let incomplete = !!st?.modelSourcesIncomplete;
  const add = qq => {
    if (!validQq(qq)) { incomplete = true; return; }
    if (selfQq && String(qq) === selfQq) return;
    actors.add(String(qq));
  };
  const addList = list => {
    if (list === undefined) return;
    if (!Array.isArray(list)) { incomplete = true; return; }
    for (const qq of list) add(qq);
  };
  addList(st?.modelSourceQqs);
  addList(b.turnEngine?.activeRequest(key)?.payload?.sourceQqs);
  for (const message of [
    ...(st?.recentMessages ?? []),
    ...(st?.unread ?? []),
    ...(b.social?.recentMessages?.get?.(key) ?? []),
    ...(b.social?.pendingSummaries?.get?.(key)?.items ?? []),
  ]) {
    if (!message || message.isSelf || message.from === 'bot') continue;
    const qq = message.userId ?? message.user_id ?? message.sender?.qq ?? message.sender?.user_id;
    add(qq);
    addList(message.sourceQqs);
    if (message.quote?.senderQq !== undefined) add(message.quote.senderQq);
  }
  return { actors: [...actors], incomplete };
}

// 做一组发送前的权限检查
export function createSendGuard(b) {
  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    return b.modeAdapterForKey?.(key)?.sendPolicy.audit ?? b.modeForKey(key) !== 'closed-agent';
  }

  // 排队期间权限可能变了，所以每条消息发送前再查一次
  function captureSendGuard(key, { ai = false, explicitAllow = false } = {}) {
    const originalSources = ai && b.cfg.architecture?.gateV2 ? toolSources(b, key) : undefined;
    const policy = b.sessionPolicy(key);
    const epoch = b.conversationEpoch?.(key);
    const sessionId = b.state.sessions[key];
    return () => {
      if (ai && (shouldBlockSilentReply(key) || (b.modeForKey(key) === 'reserved2'
          && (b.socialV2.paused || b.cfg.socialV2?.enabled === false)))) {
        throw new Error('发送已取消：AI 已暂停、关闭或进入静默模式');
      }
      if (!b.isSessionAllowedInCurrentMode(key) || policy !== b.sessionPolicy(key) || epoch !== b.conversationEpoch?.(key)
          || (sessionId && b.state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
      const [kind, rawId] = key.split(':');
      if (explicitAllow && b.modeForKey(key) === 'closed-agent'
          && !b.modeAllowed(key, kind, Number(rawId), b.cfg, b.currentMode, { listed: true })) {
        throw new Error('发送已取消：目标已不在白名单');
      }
      if (ai && b.cfg.architecture?.gateV2) {
        if (kind === 'private') {
          const decision = b.gateDecide({ kind, id: Number(rawId), qq: rawId });
          if (!decision.allowed || !decision.flags.respond) throw new Error(`发送已取消：成员策略不允许回应（${decision.allowed ? 'respond=false' : decision.reason}）`);
        } else {
          const current = toolSources(b, key);
          const actors = new Set([...current.actors, ...(originalSources?.actors ?? [])]);
          const incomplete = current.incomplete || originalSources?.incomplete;
          if (incomplete || !actors.size) {
            throw new Error(`发送已取消：成员策略不允许回应（${incomplete ? 'model-sources-incomplete' : 'source-unknown'}）`);
          }
          for (const qq of actors) {
            const decision = b.gateDecide({ kind, id: Number(rawId), qq });
            if (!decision.allowed || !decision.flags.context || !decision.flags.converse || !decision.flags.respond) {
              throw new Error(`发送已取消：成员策略不允许回应（${decision.allowed ? 'respond=false' : decision.reason}）`);
            }
          }
        }
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = b.readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(b.cfg.ownerQQ ?? '')}`;
  }

  /** 语音发送前先查文件名，别把敏感信息带出去 */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = b.hasKnownTokenFragment(text);
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      b.log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      b.appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  return { shouldAuditKey, captureSendGuard, shouldBlockSilentReply, assertOutboundAuditOk };
}
