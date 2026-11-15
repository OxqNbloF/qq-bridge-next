import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { canonicalV2Key } from '../../../policy/access.js';
import { assertMemoryWriteAllowed } from '../../../memory/write-guard.js';

export function createConsoleTermsRoutes(b) {
  return async function consoleTermsRoutes(rq) {
    if (!(rq.req.method === 'GET' && rq.url.pathname === '/api/console/memory/terms')
      && !(rq.req.method === 'POST' && rq.url.pathname === '/api/console/memory/terms')
      && !(rq.req.method === 'DELETE' && rq.url.pathname === '/api/console/memory/terms')) return ROUTE_NEXT;
    const body = rq.req.method === 'GET' ? {} : await rq.readBody();
    if (!body || typeof body !== 'object' || Array.isArray(body)) { rq.sendJson({ ok: false, error: '请求体必须是对象' }, 400); return; }
    const rawKey = body.key ?? rq.url.searchParams.get('key') ?? 'global';
    const key = rawKey === 'global' ? rawKey : canonicalV2Key(rawKey);
    if (!key) { rq.sendJson({ ok: false, error: '会话 key 非法' }, 400); return; }
    if (rq.req.method === 'GET') {
      try { rq.sendJson({ ok: true, writable: b.termsWritable, items: b.terms.query(key) }); }
      catch { rq.sendJson({ ok: false, writable: false, error: '词汇记忆池不可读，请修复原文件后重启' }, 503, { safeError: true }); }
      return;
    }
    if (!b.termsWritable) { rq.sendJson({ ok: false, error: '词汇记忆只读，请修复原文件后重启' }, 503, { safeError: true }); return; }
    if (rq.req.method === 'POST') {
      try {
        // 全局人工词汇没有会话来源；会话内的人工写入仍尊重成员隐私。
        if (key !== 'global') assertMemoryWriteAllowed(b, key);
        rq.sendJson({ ok: true, item: b.terms.append(key, body.content, { ...body, source: 'manual' }) });
      }
      catch (error) { rq.sendJson({ ok: false, error: error.message }, error.statusCode ?? 400); }
      return;
    }
    if (rq.req.method === 'DELETE') {
      if (body.confirm !== true || !body.content) { rq.sendJson({ ok: false, error: '删除需要 content 与确认' }, 400); return; }
      try { rq.sendJson({ ok: true, removed: b.terms.remove(key, body.content) }); }
      catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); }
      return;
    }
    rq.sendJson({ ok: false, error: 'method not allowed' }, 405);
  };
}
