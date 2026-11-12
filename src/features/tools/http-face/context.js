// 工具日志、反馈、消息详情、合并转发、成员、记忆、黑话这些网页接口
// 请求进来先用 rq 装着，要用外面的功能就通过 b
// 没匹配到就返回 ROUTE_NEXT，交给后面的路由接着找
// 登录和权限在 bridge.js 前面都查过了，这里不重复也不绕过
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import fs from 'node:fs';
import { formatForwardResponse } from '../../../forward.js';
import { truncateText } from '../../../md-to-plain.js';
import { canonicalV2Key, allowed } from '../../../policy/access.js';
import { buildSlangContext, createSlangEntry, SLANG_STATUS, normalizeSlangScope, mergeEvidence } from '../../../slang-learner.js';
import { atomicWriteJson } from '../../../store/fs-atomic.js';

// 做出处理日志、反馈、消息、记忆、黑话的请求处理器
export function createToolContextRoutes(b) {
  return async function toolContextRoutes(rq) {
    // ── 工具调用日志 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/tool-log') {
      const limit = Math.min(500, Math.max(1, Number(rq.url.searchParams.get('limit')) || 200));
      rq.sendJson({ ok: true, entries: b.readToolLog(limit) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/tool-log/clear') {
      if (rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
      try { fs.writeFileSync(b.TOOL_LOG_FILE, '', 'utf8'); } catch {}
      b.log('控制台：工具调用日志已清空');
      rq.sendJson({ ok: true });
      return;
    }
    // ── 反馈、我发过的消息、消息详情、活跃成员 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/feedback') {
      rq.sendJson({ ok: true, entries: b.readFeedbackEntries() });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/feedback-clear') {
      if (rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
      atomicWriteJson(b.FEEDBACK_FILE, []);
      b.log('控制台：清空 AI 反馈');
      rq.sendJson({ ok: true });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/feedback') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
      const rawMessage = String(body.message ?? '').trim();
      if (!key || !rawMessage) { rq.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('feedback')) { rq.sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
      // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
      const fNow = Date.now();
      const fTimes = b.feedbackTimes.get(key) || [];
      const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
      const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
      if (fRecentMinute >= 5 || fRecentHour >= 20) {
        rq.sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
        return;
      }
      fTimes.push(fNow);
      b.feedbackTimes.set(key, fTimes.slice(-100));
      const maxLength = Math.max(1, Number(b.cfg.socialV2?.feedback?.maxLength) || 500);
      const message = truncateText(rawMessage, maxLength);
      b.appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
      b.log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
      b.appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
      if (b.cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && b.cfg.ownerQQ) {
        b.log(`[reserved2] 错误级反馈，可通知 owner ${b.cfg.ownerQQ}（当前仅记录日志）`);
      }
      rq.sendJson({ ok: true, key, level, message });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/my-recent') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(rq.url.searchParams.get('limit')) || 10));
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getMyRecent')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
      const st = b.getSocialV2State(key);
      const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
      rq.sendJson({ ok: true, key, messages: mine, readThroughSeq: b.readThroughSeqV2(st) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/record-sent') {
      // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
      rq.sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/message-detail') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const messageId = String(rq.url.searchParams.get('messageId') ?? '').trim();
      if (!key || !messageId) { rq.sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getMessageDetail')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      try {
        const st = b.getSocialV2State(key);
        const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
        const forwardFields = found ? {
          forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
          hasForward: !!found.hasForward
        } : {};
        let info = null;
        // 本地能查到就先用本地的，避免和真实 id 弄混
        if (found && found.messageId && String(found.messageId) !== messageId) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 200),
            userId: found.userId ? String(found.userId) : null,
            messageId: String(found.messageId),
            seq: found.seq
          };
        } else {
          info = await b.resolveReplyInfo(kind, id, messageId);
          if (!info && found) {
            info = {
              sender: String(found.sender || ''),
              text: String(found.text || found.plain || '').slice(0, 200),
              userId: found.userId ? String(found.userId) : null,
              messageId: found.messageId ? String(found.messageId) : null,
              seq: found.seq
            };
          }
        }
        // 不管消息哪来的，本地有就补上转发信息，和提示词保持一致
        if (info && found) Object.assign(info, forwardFields);
        // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
        if (info) info.textTruncated = String(info.text ?? '').length >= 200;
        rq.sendJson({ ok: true, key, messageId, info });
      } catch (error) {
        rq.sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // ── 合并转发的查询接口 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/forward-message') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const id = String(rq.url.searchParams.get('id') ?? '').trim();
      const agentToken = String(rq.req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      if (!id) { rq.sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
      if (b.currentMode !== 'reserved2') {
        rq.sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
        return;
      }
      if (!agentToken) {
        rq.sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
        return;
      }
      if (!b.agentTokenOk(key, agentToken)) {
        rq.sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const num = Number(keyMatch[2]);
      if (!Number.isFinite(num) || num <= 0 || !b.modeAllowed(key, kind, num, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      if (!b.v2ToolEnabled('getForwardMsg')) {
        rq.sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
        return;
      }
      // 只能读本会话见过的转发，防止 AI 到处乱读
      const st = b.getSocialV2State(key);
      const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
      const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
      const seenInMemory = b.seenForwardIds.get(key)?.has(id) === true;
      if (!seenInRecent && !seenInUnread && !seenInMemory) {
        rq.sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
        return;
      }
      try {
        const data = await b.bot.raw('get_forward_msg', { id });
        const formatted = formatForwardResponse(data);
        // 记下这个转发，以后还能再打开
        const remember = (fid) => {
          if (!fid) return;
          let set = b.seenForwardIds.get(key);
          if (!set) {
            set = new Set();
            b.seenForwardIds.set(key, set);
          }
          set.add(fid);
          if (set.size > 1000) {
            for (const old of set) {
              set.delete(old);
              if (set.size <= 1000) break;
            }
          }
        };
        // 记下这层出现过的转发，以后 AI 还能再读
        for (const m of formatted.messages || []) {
          for (const fid of m.nestedForwardIds || []) remember(fid);
        }
        // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
        const nestedPreviews = [];
        const nestedIds = [];
        const seenNested = new Set();
        for (const m of formatted.messages || []) {
          for (const fid of m.nestedForwardIds || []) {
            if (!seenNested.has(fid) && nestedIds.length < 5) {
              seenNested.add(fid);
              nestedIds.push(fid);
            }
          }
        }
        for (const fid of nestedIds) {
          try {
            const ndata = await b.bot.raw('get_forward_msg', { id: fid });
            const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
            for (const nm of nfmt.messages || []) {
              for (const nfid of nm.nestedForwardIds || []) remember(nfid);
            }
            nestedPreviews.push({ id: fid, ...nfmt });
          } catch (error) {
            b.log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
            nestedPreviews.push({ id: fid, error: '嵌套转发读取失败' });
          }
        }
        // 把本层出现的媒体登记为「本会话确实见过」，供 qq_get_forward_media 取图。
        // 与 seenForwardIds 是同一套思路：只允许取回本会话见过的转发内容。
        b.rememberForwardMedia(key, formatted.messages || []);
        rq.sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
      } catch (error) {
        b.log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/forward-media') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const requestedMedia = Array.isArray(body.media) ? body.media : [];
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getForwardMsg')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
      if (b.currentMode !== 'reserved2') { rq.sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
      if (body.media != null && !Array.isArray(body.media)) { rq.sendJson({ ok: false, error: 'media 必须是数组' }, 400); return; }
      if (requestedMedia.length > b.MAX_MEDIA_COUNT) { rq.sendJson({ ok: false, error: `media 数量超限（最多 ${b.MAX_MEDIA_COUNT} 项）` }, 400); return; }
      // ── 只给本会话真的见过的转发图片 ──
      // 不让调用方自己编网址，不然别人能借桥接去随便下载东西
      const refs = b.forwardMediaRefs.get(canonicalV2Key(key));
      const media = [];
      for (const requested of requestedMedia) {
        const ref = b.forwardMediaKey(requested);
        const record = ref && refs?.get(ref);
        if (!record || record.until <= Date.now()) {
          rq.sendJson({ ok: false, error: '媒体不在当前会话已读取的转发节点中' }, 403);
          return;
        }
        media.push({ ...record.media });
      }
      if (!media.length) { rq.sendJson({ ok: true, key, media: [], images: [] }); return; }
      try {
        const images = await b.fetchMediaData(media);
        rq.sendJson({ ok: true, key, media, images });
      } catch (error) {
        b.log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
        rq.sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/active-members') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(20, Math.max(1, Number(rq.url.searchParams.get('limit')) || 10));
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getActiveMembers')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
      const st = b.getSocialV2State(key);
      const map = new Map();
      for (const m of st.recentMessages) {
        if (!m || m.isSelf) continue;
        const uid = m.userId ? String(m.userId) : '';
        const key2 = uid || String(m.sender || '未知');
        const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
        if (!cur.userId && uid) cur.userId = uid;
        cur.count += 1;
        if (m.time > cur.lastTime) cur.lastTime = m.time;
        if (m.isOwner) cur.isOwner = true;
        map.set(key2, cur);
      }
      const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
      // ── 隐私：默认不把 QQ 号和管理员身份给 AI ──
      // 默认只给群名片，要 QQ 号得在配置里明确打开
      rq.sendJson({ ok: true, key, members: b.agentMemberView(members, !!rq.req.headers['x-agent-token']) });
      return;
    }
    // ── 群成员列表：给 AI 一个能用的查询接口 ──
    // 旧接口在有些模式下永远报错，AI 一直被提示词引到死路上
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/group-members') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(rq.url.searchParams.get('limit')) || 50));
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      const groupMatch = /^group:(\d+)$/.exec(key);
      if (!groupMatch) { rq.sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      // 不能只看有没有令牌，不然拿任意群号都能查
      // 封闭模式下管理员私聊也要能查某群成员，所以这里单独放行
      const groupMembersAllowed = b.currentMode === 'closed-agent'
        ? allowed('group', Number(groupMatch[1]), b.cfg)
        : b.v2SessionAllowed(key);
      if (!groupMembersAllowed) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getGroupMembers')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return; }
      const groupId = Number(groupMatch[1]);
      try {
        let response;
        try {
          response = await b.bot.request('get_group_member_list', { group_id: groupId });
        } catch (wsError) {
          // 和表情库一样：长连接断了不代表服务挂了，改走普通请求再试
          response = await b.onebotHttpAction('get_group_member_list', { group_id: groupId });
        }
        const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
        const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
        if (!raw) { rq.sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return; }
        const members = raw.slice(0, limit).map((m) => ({
          userId: m?.user_id != null ? String(m.user_id) : '',
          nickname: truncateText(String(m?.nickname ?? ''), 40),
          card: truncateText(String(m?.card ?? ''), 40),
          ...(m?.role ? { role: String(m.role) } : {})
        })).filter((m) => m.userId);
        rq.sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
      } catch (error) {
        b.log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/memory-append') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
      if (!key || !category || !content) { rq.sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { rq.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
      if (category === 'memberImpression' && !String(extra.target || '').trim()) { rq.sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('memory')) { rq.sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
      const st = b.getSocialV2State(key);
      b.appendMemoryV2(st, category, content, extra);
      rq.sendJson({ ok: true, key, category, content, memory: b.formatMemoryV2(st) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/memory-update') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const oldContent = String(body.oldContent ?? '').trim();
      const target = b.redactKnownTokensOnly(String(body.target ?? '').trim());
      const newContent = body.newContent !== undefined && body.newContent !== null ? b.redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
      const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
      // 去掉里面可能出现的令牌，再交给后面
      const redactExtra = (v) => b.redactKnownTokensOnly(String(v ?? '')).trim();
      const cleanNewExtra = {
        ...newExtra,
        pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
        participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
        motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
        target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
      };
      if (!key || !category) { rq.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { rq.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
      if (category === 'memberImpression' && !target) { rq.sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
      if (category !== 'memberImpression' && !oldContent) { rq.sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('memory')) { rq.sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
      const st = b.getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { rq.sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
        if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
        if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { rq.sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
        if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
        if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        const oldTarget = target;
        if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { rq.sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
        // 只能改已经存在的印象，不能凭空新建
        // 特殊名字（比如 toString）会写到系统对象上，数据会悄悄丢掉
        if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
          rq.sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
          return;
        }
        const im = st.memberImpressions[oldTarget];
        const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
        if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { rq.sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
        if (newContent !== undefined) {
          im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
        }
        if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
        if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
        st.memberImpressions[newTarget] = im;
        // 最多存 50 条，超了就把最久没出现的删掉
        // 不设上限的话，状态文件会越写越大
        const impressionEntries = Object.entries(st.memberImpressions);
        if (impressionEntries.length > 50) {
          impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
          for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
      b.saveSocialV2State();
      rq.sendJson({ ok: true, key, category, memory: b.formatMemoryV2(st) });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/memory') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const category = String(rq.url.searchParams.get('category') ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('memory')) { rq.sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
      const st = b.getSocialV2State(key);
      const raw = {
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
      };
      if (category === 'activeTopic') {
        raw.pendingThoughts = [];
        raw.memberImpressions = {};
      } else if (category === 'pendingThought') {
        raw.activeTopics = [];
        raw.memberImpressions = {};
      } else if (category === 'memberImpression') {
        raw.activeTopics = [];
        raw.pendingThoughts = [];
      }
      rq.sendJson({ ok: true, key, category, formatted: b.formatMemoryV2({ ...st, ...raw }), raw });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/memory-remove') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const target = String(body.target ?? '').trim();
      if (!key || !category) { rq.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { rq.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
      if (category === 'memberImpression' && !target) { rq.sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
      if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { rq.sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
      if (category !== 'memberImpression' && !content) { rq.sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('memory')) { rq.sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
      const st = b.getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        delete st.memberImpressions[target];
      }
      b.saveSocialV2State();
      rq.sendJson({ ok: true, key, category, memory: b.formatMemoryV2(st) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/memory-clear') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { rq.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('memory')) { rq.sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
      const st = b.getSocialV2State(key);
      if (!category || category === 'activeTopic') st.activeTopics = [];
      if (!category || category === 'pendingThought') st.pendingThoughts = [];
      if (!category || category === 'memberImpression') st.memberImpressions = {};
      b.saveSocialV2State();
      rq.sendJson({ ok: true, key, category: category || 'all', memory: b.formatMemoryV2(st) });
      return;
    }
    // ── AI 学黑话：查询和提交词条 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/slang/query') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const q = String(rq.url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('slangQuery')) { rq.sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
      const list = b.confirmedSlangListV2(key).filter((e) => {
        if (!q) return true;
        return e.content.toLowerCase().includes(q)
          || e.meaning.toLowerCase().includes(q)
          || e.usage.toLowerCase().includes(q)
          || e.example.toLowerCase().includes(q);
      });
      rq.sendJson({
        ok: true,
        key,
        total: list.length,
        entries: list,
        block: buildSlangContext(b.slangEntries, b.cfg.slang?.injectMax ?? 8, key)
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/slang/submit') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const content = b.redactKnownTokensOnly(String(body.content ?? '')).trim();
      const context = b.redactKnownTokensOnly(String(body.context ?? '')).trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('slangSubmit')) { rq.sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
      if (b.cfg.slang?.enabled === false) { rq.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
      if (!content) { rq.sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
      if (content.length > 50) { rq.sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
      if (!b.allowSlangSubmit(key)) { rq.sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
      const scope = canonicalV2Key(key);
      if (!scope) { rq.sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
      const existing = b.slangEntries.find((e) => e.content === content && normalizeSlangScope(e.scope) === scope);
      if (existing) {
        if (existing.status === SLANG_STATUS.CONFIRMED) {
          rq.sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: b.publicSlangEntry(existing) });
          return;
        }
        if (existing.status === SLANG_STATUS.REJECTED) {
          rq.sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
          return;
        }
        // candidate：累计出现次数并追加语境证据
        existing.count = (Number(existing.count) || 0) + 1;
        if (context) {
          existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
        }
        existing.updatedAt = new Date().toISOString();
        b.saveSlangStore();
        if (b.cfg.slang?.autoResearch !== false) {
          const thresholds = Array.isArray(b.cfg.slang?.inferenceThresholds) ? b.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
          if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
            b.queueSlangTask(() => b.runSlangResearch([existing]));
          }
        }
        b.log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
        rq.sendJson({ ok: true, duplicate: true, status: 'candidate', entry: b.publicSlangEntry(existing) });
        return;
      }
      const entry = createSlangEntry({
        content,
        source: 'ai',
        status: SLANG_STATUS.CANDIDATE,
        // 记在提交它的那个聊天下，别塞给别人
        scope,
        evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
      });
      b.slangEntries.push(entry);
      b.saveSlangStore();
      if (b.cfg.slang?.autoResearch !== false) {
        b.queueSlangTask(() => b.runSlangResearch([entry]));
      }
      b.log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
      b.appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
      rq.sendJson({ ok: true, entry: b.publicSlangEntry(entry) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/authorize/read') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      if (!token || !b.agentTokenOk(key, token)) {
        // 没带令牌一律拒绝，不然这个接口就成了谁都能用的入口
        rq.sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return;
      }
      rq.sendJson({ ok: true, key });
      return;
    }
    return ROUTE_NEXT;
  };
}
