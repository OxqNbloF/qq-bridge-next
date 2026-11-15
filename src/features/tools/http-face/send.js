// 看图端点与统一发送端点 /api/agent/send/group|private|reply
import { rememberModelSources } from '../../../memory/model-sources.js';
import { modelMessageVisible } from '../../../gate/model-visibility.js';
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { unquoteJsonString } from '../../../policy/audit.js';

// 注册看图与发送路由
export function createToolSendRoutes(b) {
  return async function toolSendRoutes(rq) {
    // 图片/表情查询端点
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/agent/images/message') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const messageId = String(rq.url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(rq.req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      if (!messageId) { rq.sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
      if (b.modeForKey(key) === 'reserved2' && !agentToken) {
        rq.sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
        return;
      }
      if (!rq.toolPolicy && ['chat', 'reserved'].includes(b.modeForKey(key) ?? b.currentMode)) {
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
      const st = b.getSocialV2State(key);
      const epoch = b.conversationEpoch?.(key);
      const mode = b.modeForKey(key);
      const findSource = () => [...(st.recentMessages ?? []), ...(st.unread ?? []),
        ...(b.social?.recentMessages?.get(key) ?? [])].find(m => m &&
          (String(m.messageId ?? '') === messageId || String(m.seq ?? '') === messageId));
      const source = findSource();
      if ((source && !modelMessageVisible(b, key, source)) || (!source && b.cfg.architecture?.gateV2)) {
        rq.sendJson({ ok: false, error: '成员策略不允许读取图片来源或来源已不在可验证窗口内' }, 403);
        return;
      }
      const media = b.findMessageMedia(key, messageId);
      if (!media.length) {
        rq.sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
        return;
      }
      try {
        const images = await b.fetchMediaData(media);
        const currentSource = findSource();
        if (b.getSocialV2State(key) !== st || epoch !== b.conversationEpoch?.(key) ||
            mode !== b.modeForKey(key) ||
            !b.modeAllowed(key, kind, id, b.cfg, b.currentMode) ||
            (agentToken && (!b.agentTokenOk(key, agentToken) || !b.v2ToolEnabled('getImages') ||
              (b.modeForKey(key) === 'reserved2' && (b.socialV2.paused || b.cfg.socialV2?.enabled === false)))) ||
            (source && !modelMessageVisible(b, key, source)) ||
            (currentSource && !modelMessageVisible(b, key, currentSource)) ||
            (!currentSource && b.cfg.architecture?.gateV2)) {
          rq.sendJson({ ok: false, error: '等待期间图片来源已不可读取，请重新读取会话' }, 403);
          return;
        }
        // 图片结果没有 userId；在曝光前显式保留其来源，不能依赖 HTTP wrapper。
        rememberModelSources(b, key, [source, currentSource]);
        rq.sendJson({ ok: true, messageId, media, images });
      } catch (error) {
        b.log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
      }
      return;
    }

    // 统一发送端点
    if (rq.req.method === 'POST' && (rq.url.pathname === '/api/agent/send/group' || rq.url.pathname === '/api/agent/send/private' || rq.url.pathname === '/api/agent/send/reply')) {
      const body = await rq.readBody();
      const token = String((rq.toolPolicy || rq.req.headers['x-agent-token'] !== undefined ? rq.req.headers['x-agent-token'] : body.token) ?? '').trim();
      const isPrivate = rq.url.pathname === '/api/agent/send/private';
      const isReply = rq.url.pathname === '/api/agent/send/reply';
      const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
      const message = unquoteJsonString(String(body.message ?? '').trim());
      // 三个端点都可带引用 id，是否引用由下游判断
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
      // 发送工具只限 closed-agent 与 reserved2，防被塞东西越权
      if (!rq.toolPolicy && ['chat', 'reserved'].includes(b.modeForKey(key) ?? b.currentMode)) {
        rq.sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
        return;
      }
      if (b.socialV2.paused && token && (!rq.toolPolicy || b.modeForKey(key) === 'reserved2')) {
        rq.sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
        return;
      }
      if (!targetId || !message) { rq.sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
      if (b.modeForKey(key) === 'reserved2' && !token) { rq.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
      if ((rq.toolPolicy || token) && !b.agentTokenOk(key, token)) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (body.token !== undefined && String(body.token).trim() !== token) { rq.sendJson({ ok: false, error: '请求体与请求头令牌不一致' }, 403); return; }
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
      const st = b.getSocialV2State(key);
      const now = Date.now();
      try {
        const sentMessages = await b.sendMessagesV2(key, [message], [], replyToMessageId, atUserId, flag, { resolveReply: true, requireReply: isReply });
        b.recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        b.saveSocialV2State();
        b.log(`[send] ${rq.url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
        b.appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
        if (sentMessages.length > 0) b.scheduleReplyCheckV2(key);
        rq.sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: sentMessages.quoted });
      } catch (error) {
        if (error?.sent?.length) {
          b.recordSentMessagesV2(key, error.sent);
          b.log(`[send] ${rq.url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
        }
        b.saveSocialV2State();
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, error?.statusCode ?? 500);
      }
      return;
    }
    return ROUTE_NEXT;
  };
}
