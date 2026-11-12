// 控制台会话与挂起审批的路由；鉴权已在分发前完成
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';

// 创建会话相关路由；未命中返回 ROUTE_NEXT
export function createConsoleSessionRoutes(b) {
  // 执行一次覆盖表变更并返回结果
  function changeOverride(rq, change) {
    try {
      const result = change();
      rq.sendJson({ ok: true, key: result.key, policyChanged: result.auditEvent.policyChanged, ...b.listConversationOverrides() });
    } catch (error) {
      // TypeError 是请求错误回 400，其余回 500
      rq.sendJson({ ok: false, error: error?.message ?? String(error) }, error instanceof TypeError ? 400 : 500);
    }
  }

  return async function consoleSessionRoutes(rq) {
    // ── 会话查看 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/sessions') {
      const list = [];
      for (const [key, sessionId] of Object.entries(b.state.sessions)) {
        list.push({ key, sessionId, owner: key === `private:${String(b.cfg.ownerQQ ?? '')}` });
      }
      rq.sendJson({ sessions: list });
      return;
    }
    // ── 挂起审批 / 提问 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/pending') {
      const list = [];
      for (const [key, p] of b.pending.entries()) {
        list.push({
          key,
          kind: p.kind,
          sessionId: p.sessionId,
          ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
          ...(p.kind === 'question' ? { questions: p.questions } : {})
        });
      }
      rq.sendJson({ pending: list });
      return;
    }
    // ── 每会话策略覆盖表（仅记录） ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/conversations') {
      rq.sendJson({ ok: true, ...b.listConversationOverrides() });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/conversations/set') {
      const body = await rq.readBody();
      changeOverride(rq, () => b.setConversationOverride(body.key, body, 'console'));
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/conversations/delete') {
      const body = await rq.readBody();
      changeOverride(rq, () => b.deleteConversationOverride(body.key, 'console'));
      return;
    }
    return ROUTE_NEXT;
  };
}
