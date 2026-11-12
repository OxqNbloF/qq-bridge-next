// 本地 HTTP 面的公共底座；不做任何鉴权放行

export const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});

/** 读出请求地址；不合法就回 400 并返回 null */
export function parseRequestUrl(req, res, port) {
  let url;
  try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
    res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
    return null;
  }
  return url;
}

/**
 * 创建 JSON 应答函数
 * @returns {Function} 用来发 JSON 答复的函数
 */
export function createSendJson({ req, res, url, log }) {
  return (obj, status = 200, { safeError = false } = {}) => {
    // 内部异常只写本机日志，不外泄给客户端
    if (status >= 500 && obj?.ok === false && !safeError) {
      log(`控制台请求失败 ${req.method} ${url.pathname}:`, obj.error);
      obj = {
        ok: false, error: '操作失败，请查看本机 state/bridge.log 排查。',
        ...(obj.status ? { status: obj.status } : {})
      };
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    res.end(JSON.stringify(obj, null, 2));
  };
}

/** 读 JSON 对象请求体：上限 1MB、30 秒超时 */
export function createReadBody(req, timers) {
  return () => new Promise((resolve, reject) => {
    const MAX_BODY_BYTES = 1_000_000;
    const chunks = [];
    let total = 0;
    let settled = false;
    let bodyTimer = null;
    // 以带 statusCode 的错误结束
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) timers.clearTimeout(bodyTimer);
      const err = new Error(message);
      err.statusCode = status;
      reject(err);
    };
    // 读完了，交结果
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) timers.clearTimeout(bodyTimer);
      resolve(val);
    };
    // 按 Content-Length 提前拒绝超限请求体
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(413, '请求体过大（超过 1MB）');
      return;
    }
    bodyTimer = timers.setTimeout(() => fail(400, '请求体读取超时'), 30000);
    req.on('data', (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) { done({}); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(400, '请求体必须是 JSON 对象');
        return;
      }
      done(parsed);
    });
    // 超限或连接异常时也结束等待，防 handler 悬挂
    req.on('error', () => fail(400, '请求体读取失败'));
    req.on('aborted', () => fail(400, '请求体读取中断'));
  });
}

/**
 * 处理 favicon 请求
 * @returns {boolean} true 表示已应答
 */
export function handleFavicon({ req, res, url }) {
  // 在鉴权前直接 204 收掉 favicon，免 401 噪音
  if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return true;
  }
  return false;
}
