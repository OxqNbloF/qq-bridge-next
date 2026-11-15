import { escapeCqText } from '../policy/audit.js';
import { assertOutboundPolicy, assertOutboundMode } from './policy.js';
import { prepareOutboundItems, validateOutboundReferences, outboundError } from './validation.js';
import { createOutboundRate } from './rate.js';

// batch: SendIntent overrides sharing one FIFO slot and full-payload audit.
export function createOutbound(b) {
  const sendTimes = new Map();
  function enqueueOutbound(key, intent) {
    const assertSendAllowed = intent.assertSendAllowed ?? b.captureSendGuard(key, { ai: intent.ai, explicitAllow: intent.explicitAllow });
    const epoch = b.conversationEpoch?.(key);
    const audit = { key, session: b.state.sessions[key] ?? null, turn: b.turnEngine?.activeRequest(key)?.turnId ?? null,
      channel: intent.channel ?? 'system' };
    const chain = b.sendChainFor(key).then(async () => {
      let items = intent.batch ? intent.batch.map(item => ({ ...intent, ...item, batch: undefined })) : [{ ...intent }];
      const sent = [], results = [], failures = [];
      let rate, quoted = null;
      try {
        if (intent.beforeDelay) await b.sleep(intent.beforeDelay);
        assertSendAllowed();
        assertOutboundMode(b, key, intent);
        rate = createOutboundRate(b, sendTimes, key, intent);
        const initialCount = items.length;
        rate.reserve(initialCount);
        assertOutboundPolicy(b, key, { ...intent, text: items.map(item => item.text ?? item.archiveText ?? '').join('') });
        items = prepareOutboundItems(b, key, intent, items);
        if (items.length > initialCount) rate.reserve(items.length - initialCount);
        else if (items.length < initialCount) rate.release(initialCount - items.length);
        quoted = await validateOutboundReferences(b, key, intent, items);
        assertSendAllowed();
        for (const [index, item] of items.entries()) {
          try {
            assertSendAllowed();
            assertOutboundMode(b, key, item);
            rate.check();
            if (intent.channel === 'tool' && !intent.segments && !intent.action && b.cfg.socialV2?.send?.burstEnabled === false && items.length > 1) {
              throw outboundError('已禁用多条发送，请合并为一条消息', 403);
            }
            assertOutboundPolicy(b, key, item);
            const replanned = prepareOutboundItems(b, key, { ...intent, timelineText: undefined }, [item]);
            if (replanned.length !== 1 || replanned[0]?.text !== item.text) throw outboundError('分条长度策略已收紧，取消发送旧计划超长段', 403);
            const result = await sendOutbound(key, item);
            rate.commit();
            sent.push(item.text ?? item.archiveText);
            results.push(result);
            if (epoch === b.conversationEpoch?.(key)) b.lastSendFailed.delete(key);
            if (item.transport !== 'http' || item.segments || item.action) b.archiveOutgoing(key, item.archiveText ?? item.text, result, item.archiveOptions);
            b.log('[outbound]', JSON.stringify({ ...audit, text: b.redactSensitiveText(b.redactKnownTokensOnly(item.text ?? item.archiveText ?? '')), result: 'sent' }));
          } catch (error) { failures.push(error); }
          if (item.afterDelay && index < items.length - 1) await b.sleep(item.afterDelay);
        }
        if (failures.length) throw Object.assign(new Error(`QQ 发送失败 ${failures.length}/${items.length} 条：${failures[0]?.message ?? '未知错误'}`), { sent, statusCode: failures[0]?.statusCode });
        return intent.batch ? { sent, results, quoted } : results[0];
      } catch (error) {
        b.lastSendFailed.set(key, true);
        b.log('[outbound]', JSON.stringify({ ...audit, result: 'failed', error: b.redactSensitiveText(b.redactKnownTokensOnly(String(error?.message ?? error))) }));
        error.sent ??= sent;
        throw error;
      } finally {
        rate?.rollback();
      }
    });
    const afterDelay = intent.batch?.at(-1)?.afterDelay ?? intent.afterDelay;
    b.rememberSendChain(key, chain.catch(() => {}).then(() => afterDelay ? b.sleep(afterDelay) : undefined));
    return chain;
  }
  async function sendOutbound(key, intent) {
    if (intent.action) return b.withTimeout(b.bot.raw(intent.action, intent.params), b.SEND_TIMEOUT_MS, `QQ发送 ${key}`);
    const [kind, id] = key.split(':');
    if (intent.segments) {
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private' ? { user_id: Number(id), message: intent.segments } : { group_id: Number(id), message: intent.segments };
      return (await b.onebotHttpAction(action, params, { timeoutMs: intent.timeoutMs ?? 15000 })).data;
    }
    if (intent.transport === 'http') return b.onebotSend(kind, id, intent.text, intent.replyTo, intent.at);
    return b.withTimeout(kind === 'private'
      ? b.bot.sendPrivateMessage(Number(id), b.text(escapeCqText(intent.text)))
      : b.bot.sendGroupMessage(Number(id), b.text(escapeCqText(intent.text))), b.SEND_TIMEOUT_MS, `QQ发送 ${key}`);
  }
  return {
    enqueueOutbound,
    resetOutbound: (key) => {
      const list = sendTimes.get(key);
      if (list) list.length = 0;
      sendTimes.delete(key);
      const st = b.socialV2?.conversations?.get(key);
      if (Array.isArray(st?.sendTimes)) st.sendTimes.length = 0;
    },
  };
}
