// 看图端点与统一发送端点 /api/send/group|private|reply
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { unquoteJsonString } from '../../../policy/audit.js';
import { SENSITIVE_RE } from '../../../sensitive.js';

// 注册看图与发送路由
export function createToolSendRoutes(b) {
  return async function toolSendRoutes(rq) {
    // 图片/表情查询端点
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/images/message') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const messageId = String(rq.url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(rq.req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      if (!messageId) { rq.sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
      if (b.currentMode === 'reserved2' && !agentToken) {
        rq.sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
        return;
      }
      if (b.currentMode === 'chat' || b.currentMode === 'reserved') {
        rq.sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
        return;
      }
      if (agentToken && !b.agentTokenOk(key, agentToken)) {
        rq.sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      if (agentToken && !b.v2ToolEnabled('getImages')) {
        rq.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
        return;
      }
      if (!agentToken && b.modeForKey(key) === 'closed-agent' && !b.v2ToolEnabled('getImages')) {
        rq.sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
        return;
      }
      const media = b.findMessageMedia(key, messageId);
      if (!media.length) {
        rq.sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
        return;
      }
      try {
        const images = await b.fetchMediaData(media);
        rq.sendJson({ ok: true, messageId, media, images });
      } catch (error) {
        b.log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
      }
      return;
    }

    // 统一发送端点
    if (rq.req.method === 'POST' && (rq.url.pathname === '/api/send/group' || rq.url.pathname === '/api/send/private' || rq.url.pathname === '/api/send/reply')) {
      const body = await rq.readBody();
      const token = String(body.token ?? '').trim();
      const isPrivate = rq.url.pathname === '/api/send/private';
      const isReply = rq.url.pathname === '/api/send/reply';
      const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
      const message = unquoteJsonString(String(body.message ?? '').trim());
      // 三个端点都可带引用 id，是否引用由下游判断
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
      // 发送工具只限 closed-agent 与 reserved2，防被塞东西越权
      if (b.currentMode === 'chat' || b.currentMode === 'reserved') {
        rq.sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
        return;
      }
      if (b.socialV2.paused && token) {
        rq.sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
        return;
      }
      if (!targetId || !message) { rq.sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
      if (isPrivate && atUserId) { rq.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
      if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
        rq.sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
        return;
      }
      if (b.currentMode === 'reserved2' && !token) { rq.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
      if (token && !b.agentTokenOk(key, token)) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
      if (token && !b.v2ToolEnabled(flag)) { rq.sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
      if (b.shouldBlockSilentReply(key)) {
        rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        rq.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = b.getSocialV2State(key);
        const resolved = await b.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          rq.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = b.cfg.socialV2?.send ?? {};
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (message.length > maxChars) { rq.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
      if (SENSITIVE_RE.test(message)) { rq.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
      // st/now 须在 try 外声明，catch 要用它们回滚额度
      const st = b.getSocialV2State(key);
      const now = Date.now();
      try {
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
          rq.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const sentMessages = await b.sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
        b.recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        b.saveSocialV2State();
        b.log(`[send] ${rq.url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
        b.appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
        if (sentMessages.length > 0) b.scheduleReplyCheckV2(key);
        rq.sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
      } catch (error) {
        if (error?.sent?.length) {
          b.recordSentMessagesV2(key, error.sent);
          b.log(`[send] ${rq.url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
        }
        // 回滚未发出消息预占的额度，防假 429
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, 1 - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        b.saveSocialV2State();
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }
    return ROUTE_NEXT;
  };
}
