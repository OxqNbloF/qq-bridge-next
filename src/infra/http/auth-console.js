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

export const CONSOLE_SESSION_COOKIE = 'qq_console_session';

function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); }
      catch { return part.slice(idx + 1).trim(); }
    }
  }
  return '';
}

// 检查控制台访问令牌对不对
export function rejectBadConsoleToken({ req, res, url, sendJson, consoleToken }) {
  // 控制台鉴权：支持 x-console-token、?token= 或同源 HttpOnly Cookie，全部定长比较
  const suppliedToken = String(
    req.headers['x-console-token']
    ?? url.searchParams.get('token')
    ?? readCookie(req.headers.cookie, CONSOLE_SESSION_COOKIE)
    ?? ''
  );
  // 空控制台令牌必须失败关闭（tokenEq 在任一侧为空时返回 false）
  if (!tokenEq(suppliedToken, consoleToken)) {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t){const u=new URL(location.href);u.searchParams.set(\'token\',t.trim());location.href=u.pathname+u.search+u.hash;}</script>');
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
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') {
      sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
      return true;
    }
    const origin = req.headers['origin'];
    if (origin) {
      let parsedOrigin = null;
      try { parsedOrigin = new URL(String(origin)); } catch {}
      const allowedOrigins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`];
      if (!parsedOrigin || !allowedOrigins.includes(`${parsedOrigin.protocol}//${parsedOrigin.host.toLowerCase()}`)) {
        sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
        return true;
      }
    }
  }
  return false;
}
