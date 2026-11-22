// 直接调 SnowLuma 的 HTTP 接口发消息、查东西

/**
 * @param {object} o
 * @param {object} o.cfg
 * @param {typeof fetch} o.fetch
 * @param {(...a:any[])=>void} o.log
 * @param {Function} o.hasKnownTokenFragment 查有没有令牌
 * @param {(text:string)=>string} o.escapeCqText
 * @param {Function} [o.onSent] 发成功之后要执行的函数
 */
export function createOneBotHttp({ cfg, fetch: doFetch, log, hasKnownTokenFragment, escapeCqText, onSent = () => {} }) {
  // 取 OneBot HTTP 的地址
  const httpBase = () => String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 组装请求头，有令牌就带上
  const headers = () => ({
    'content-type': 'application/json',
    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
  });

  // WS 重连时读表情会失败，这里改用 HTTP 接口保底
  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const res = await doFetch(`${httpBase()}/${action}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(params ?? {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  // 发一条消息，可以带回复和 @
  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = hasKnownTokenFragment(rawMessage);
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) throw new Error(`无效的目标编号: ${id}`);
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: numId, message: segments } : { group_id: numId, message: segments };
    const body = await onebotHttpAction(action, params, { timeoutMs: 15000 });
    onSent(kind, id, rawMessage, body.data, {
      replyTo: segments.find((seg) => seg.type === 'reply')?.data?.id ?? null,
    });
    return body.data;
  }

  return { onebotHttpAction, onebotSend };
}
