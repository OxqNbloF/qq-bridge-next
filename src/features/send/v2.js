// 二代整批审计发送、回合失败通知与统一出站审计

// 创建二代发送函数，b 为桥接访问器
export function createSenderV2(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const turnNoticeTimes = new Map();    // key -> 上次失败通知时间，防刷屏
  // 整批审计后逐条发送二代消息
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, tool = messages.length > 1 ? 'sendBurst' : replyToMessageId ? 'reply' : 'sendMessage', options = {}) {
    return b.enqueueOutbound(key, { ...options, ai: true, channel: 'tool', tool, transport: 'http', rateScope: 'tool',
      batch: messages.map((text, i) => ({ text, replyTo: i === 0 ? replyToMessageId : null,
        at: i === 0 ? atUserId : null, afterDelay: delays[i] ?? 0 })),
    }).then(result => Object.defineProperty(result.sent, 'quoted', { value: result.quoted }));
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
    try { return await b.sendToQQ(key, text, { ai: true, throwOnError: true }); }
    catch (error) {
      if (error?.code !== 'OUTBOUND_AUDIT') return false;
      b.appendActivity(`${key} agent 回复被拦截（疑似敏感信息/会话令牌）`);
      if (b.cfg.security?.interceptNotify !== false) {
        await b.sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
  }

  return {
    turnNoticeTimes, sendMessagesV2, reportTurnFailure, auditAndSend };
}
