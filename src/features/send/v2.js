// 二代整批审计发送、回合失败通知与统一出站审计
import { SENSITIVE_RE } from '../../sensitive.js';

// 创建二代发送函数，b 为桥接访问器
export function createSenderV2(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const turnNoticeTimes = new Map();    // key -> 上次失败通知时间，防刷屏
  // 整批审计后逐条发送二代消息
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    // 令牌可被拆段绕过单条检查，须在发第一段前整批拒绝
    if (b.hasKnownTokenFragment(messages.join(''))) {
      b.log(`发送内容包含会话令牌，已阻止整批发送 (${key})`);
      return Promise.reject(new Error('发送内容包含会话令牌，已阻止发送'));
    }
    let sendChain = b.sendChainFor(key);
    const assertSendAllowed = b.captureSendGuard(key, { ai: true });
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await b.onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          b.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => b.sleep(d));
      }
    }
    return b.rememberSendChain(key, sendChain).then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }




  // 回合失败时给会话发固定提示（限频）
  async function reportTurnFailure(key, kind, error, notify = true) {
    if (kind === 'error') {
      const detail = b.redactSensitiveText(b.redactKnownTokensOnly(String(error?.message ?? error ?? '未知错误'))).slice(0, 500);
      b.log(`⚠️ agent 处理出错 (${key})：${detail}`);
      b.appendActivity(`${key} agent 处理出错：${detail.slice(0, 80)}`);
    } else {
      b.log(`⏹️ 回合被中止 (${key})`);
    }
    // 二代不转发；其他模式只发固定提示，错误留管理端
    if (!notify || b.modeForKey(key) === 'reserved2' || b.shouldBlockSilentReply(key)) return false;
    const now = Date.now();
    if (now - (turnNoticeTimes.get(key) ?? 0) < 5 * 60 * 1000) return false;
    turnNoticeTimes.set(key, now);
    await b.sendToQQ(key, kind === 'error' ? '⚠️ 暂时无法处理消息，请稍后再试。' : '⏹️ 已停止', { ai: true });
    return true;
  }

  // 先审计全文再发送，返回是否真的发出
  async function auditAndSend(key, text) {
    const hasKnownToken = b.hasKnownTokenFragment(text);
    if (b.shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      b.log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      b.appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (b.cfg.security?.interceptNotify !== false) {
        await b.sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await b.sendToQQ(key, text, { ai: true });
    return true;
  }

  return {
    turnNoticeTimes, sendMessagesV2, reportTurnFailure, auditAndSend };
}
