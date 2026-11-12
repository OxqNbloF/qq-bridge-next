// 发送前的最后检查：确认这条消息还允许发出去
import { allowed } from '../policy/access.js';
import { SENSITIVE_RE } from '../sensitive.js';

// 做一组发送前的权限检查
export function createSendGuard(b) {
  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    return b.modeForKey(key) !== 'closed-agent';
  }

  // 排队期间权限可能变了，所以每条消息发送前再查一次
  function captureSendGuard(key, { ai = false, explicitAllow = false } = {}) {
    const policy = b.sessionPolicy(key);
    const sessionId = b.state.sessions[key];
    return () => {
      if (ai && (shouldBlockSilentReply(key) || (b.modeForKey(key) === 'reserved2'
          && (b.socialV2.paused || b.cfg.socialV2?.enabled === false)))) {
        throw new Error('发送已取消：AI 已暂停、关闭或进入静默模式');
      }
      if (!b.isSessionAllowedInCurrentMode(key) || policy !== b.sessionPolicy(key)
          || (sessionId && b.state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
      if (explicitAllow && b.modeForKey(key) === 'closed-agent') {
        const [kind, id] = key.split(':');
        if (!allowed(kind, id, b.cfg)) throw new Error('发送已取消：目标已不在白名单');
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
