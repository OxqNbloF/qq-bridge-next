// 控制台令牌与花费页的 /api/tokens/* 路由
import { ROUTE_NEXT } from '../../infra/http/route-next.js';

// 创建令牌用量路由处理器
export function createUsageDashboardRoutes(b) {
  return async function usageDashboardRoutes(rq) {
    // 跨群花费是管理信息：带 x-agent-token 的请求一律 403
    if (rq.url.pathname === '/api/tokens/summary' || rq.url.pathname.startsWith('/api/tokens/')) {
      if (rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
      if (rq.req.method === 'GET' && rq.url.pathname === '/api/tokens/summary') {
        const limit = Math.min(500, Math.max(1, Number(rq.url.searchParams.get('limit')) || 200));
        rq.sendJson({ ...b.tokenLedger.summary({ limit }), ledger: b.tokenLedger.stats() });
        return;
      }
      if (rq.req.method === 'GET' && rq.url.pathname === '/api/tokens/series') {
        const hours = Math.min(24 * 90, Math.max(1, Number(rq.url.searchParams.get('hours')) || 24));
        const maxBuckets = Math.min(120, Math.max(6, Number(rq.url.searchParams.get('buckets')) || 48));
        rq.sendJson(b.tokenLedger.series({ hours, maxBuckets }));
        return;
      }
      if (rq.req.method === 'GET' && rq.url.pathname === '/api/tokens/turns') {
        const key = String(rq.url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(1000, Math.max(1, Number(rq.url.searchParams.get('limit')) || 200));
        const detail = b.tokenLedger.conversation(key, { turnLimit: limit });
        if (!detail) { rq.sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
        rq.sendJson(detail);
        return;
      }
      if (rq.req.method === 'GET' && rq.url.pathname === '/api/tokens/recent') {
        const limit = Math.min(500, Math.max(1, Number(rq.url.searchParams.get('limit')) || 50));
        rq.sendJson({ ok: true, symbol: b.priceTable.symbol, entries: b.tokenLedger.recent(limit) });
        return;
      }
      if (rq.req.method === 'POST' && rq.url.pathname === '/api/tokens/reset') {
        b.tokenLedger.reset();
        b.log('控制台：token 用量账本已重置');
        rq.sendJson({ ok: true });
        return;
      }
      rq.sendJson({ ok: false, error: 'not found' }, 404);
      return;
    }
    return ROUTE_NEXT;
  };
}
