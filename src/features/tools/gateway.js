import { canonicalV2Key } from '../../policy/access.js';
import { assertMemoryWriteAllowed } from '../../memory/write-guard.js';

import { TOOL_ROUTES, assertToolMemberAllowed } from '../../gate/tool.js';
export { TOOL_ROUTES } from '../../gate/tool.js';

export function createToolGateway(b) {
  async function authorizeToolRequest({ req, url, readBody, sendJson, tokenState }) {
    const reject = (error) => { b.log(`[tools] ${req.method} ${url.pathname} denied: ${error}`); sendJson({ ok: false, error }, 403); return false; };
    if (req.headers['x-agent-call'] !== '1') return reject('智能体调用必须携带 x-agent-call: 1');
    const rule = TOOL_ROUTES[`${req.method} ${url.pathname}`];
    if (!rule) return reject('该接口未向智能体开放');
    if (url.pathname === '/api/agent/status' && !tokenState && req.headers['x-agent-token'] === undefined) return true; // 控制台令牌已在外层校验。
    if (!tokenState) return reject('智能体调用必须携带有效的会话令牌');
    const key = tokenState[0];
    const mode = b.modeForKey(key);
    const policy = b.modeAdapterForKey(key)?.toolPolicy;
    if (!policy || !b.isSessionAllowedInCurrentMode(key)) return reject('会话已失效或不在允许范围内');
    const body = req.method === 'GET' ? {} : await readBody();
    const flag = url.pathname === '/api/agent/check-send' && ['sendGroup', 'sendPrivate', 'reply'].includes(body.tool) ? body.tool : rule[1];
    if (url.pathname === '/api/agent/check-send' && !flag) return reject('未知发送工具');
    if (!policy.groups.includes(rule[0]) || policy.deny.includes(flag)) return reject('当前模式不允许该工具');
    if (flag && !b.v2ToolEnabled(flag)) return reject(`工具未启用：${flag}`);
    if (mode === 'reserved2' && (b.socialV2.paused || b.cfg.socialV2?.enabled === false)) return reject('二代 AI 已暂停或关闭');
    const sendRoute = url.pathname.startsWith('/api/agent/send/');
    const target = sendRoute
      ? `${url.pathname === '/api/agent/send/private' ? 'private' : 'group'}:${String((url.pathname === '/api/agent/send/private' ? body.userId : body.groupId) ?? '').trim()}` : body.key ?? body.target ?? key;
    const candidates = [target, ...url.searchParams.getAll('key'), body.key, sendRoute ? body.target : undefined].filter((value) => value !== undefined);
    if (candidates.some((value) => canonicalV2Key(value) !== canonicalV2Key(key))) return reject('令牌不能跨会话使用');
    if (body.token !== undefined && body.token !== req.headers['x-agent-token']) return reject('请求体与请求头令牌不一致');
    if (rule[2] === 'respond') {
      try { b.captureSendGuard(canonicalV2Key(target), { ai: true })(); }
      catch (error) { return reject(error.message); }
    }
    if (rule[0] === 'memory' && req.method === 'POST' && ['memory-append', 'memory-update'].some(path => url.pathname.endsWith(`/${path}`))) {
      if (String(body.category ?? '').trim() === 'memberImpression') {
        const targets = url.pathname.endsWith('/memory-append') ? [body.extra?.target] : [body.target, body.newExtra?.target];
        if (targets.some(value => ['__proto__', 'constructor', 'prototype'].includes(String(value ?? '').trim()))) {
          sendJson({ ok: false, error: '非法的群友名字' }, 400);
          return false;
        }
      }
      try { assertMemoryWriteAllowed(b, key); }
      catch (error) { return reject(error.message); }
    }
    try { assertToolMemberAllowed(b, key, rule); }
    catch (error) { return reject(error.message); }
    b.log(`[tools] ${key} ${req.method} ${url.pathname} allowed`);
    return true;
  }
  return { authorizeToolRequest };
}
