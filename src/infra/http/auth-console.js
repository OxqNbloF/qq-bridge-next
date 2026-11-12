// 控制台入口的三道检查：来源地址、访问令牌、跨站提交
import crypto from 'node:crypto';
import { SECURITY_HEADERS } from './server.js';

// 比较令牌用固定时间的方式，别让人靠响应快慢猜出令牌
export const tokenEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** @param {object} o 含请求、答复函数和实际端口 */
export function rejectBadHost({ req, sendJson, boundPort }) {
  // 只接受本机地址访问，防止恶意网页伪装成本机
  const hostHeader = String(req.headers.host ?? '');
  const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
  if (!allowedHosts.includes(hostHeader.toLowerCase())) {
    sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
    return true;
  }
  return false;
}

// 检查控制台访问令牌对不对
export function rejectBadConsoleToken({ req, res, url, sendJson, consoleToken }) {
  // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
  // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
  // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
  const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
  // 用不会泄露信息的方式比较两个令牌
  const tokenMatches = (() => {
    if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
    const a = Buffer.from(suppliedToken, 'utf8');
    const b = Buffer.from(consoleToken, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  })();
  if (consoleToken && !tokenMatches) {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
    } else {
      sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
    }
    return true;
  }
  return false;
}

// 拒绝别的网站假冒本机页面发来的写请求
export function rejectCsrf({ req, sendJson, boundPort }) {
  // 写操作必须是本站页面发的，防止别的网站偷偷触发重启等操作
  if (req.method !== 'GET') {
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.toLowerCase().includes('application/json')) {
      sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
      return true;
    }
    const origin = req.headers['origin'];
    if (origin) {
      let originHost = '';
      try { originHost = new URL(String(origin)).host; } catch {}
      if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
        sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
        return true;
      }
    }
  }
  return false;
}
