// 普通模式发送器：按聊天排队、发送前再检查权限
import { splitForQQ } from '../../md-to-plain.js';
import { escapeCqText } from '../../policy/audit.js';

// 创建发送器；b 是桥接传进来的东西的入口
export function createSender(b) {
  // 把消息排队发到 QQ 会话，失败记账
  function sendToQQ(key, msg, { ai = false } = {}) {
    let sendChain = b.sendChainFor(key);
    const assertSendAllowed = b.captureSendGuard(key, { ai });
    const safeMsg = b.redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    b.lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          const result = kind === 'private'
            ? await b.withTimeout(b.bot.sendPrivateMessage(Number(id), b.text(escapeCqText(part))), b.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)
            : await b.withTimeout(b.bot.sendGroupMessage(Number(id), b.text(escapeCqText(part))), b.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          b.archiveOutgoing(key, part, result);
        })
        .catch((error) => {
          b.lastSendFailed.set(key, true);
          b.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => b.sleep(b.cfg.sendDelayMs));
    }
    return b.rememberSendChain(key, sendChain);
  }

  return { sendToQQ };
}
