// SSRF 防护网页抓取与搜索工具（仅允许公网 HTTP/HTTPS，校验解析后的所有 IP 并阻止内网重定向）
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export function isPrivateIp(ip) {
  const raw = String(ip ?? '').trim().toLowerCase();
  if (!raw) return true;
  if (raw.startsWith('::ffff:')) return isPrivateIp(raw.slice(7));
  if (net.isIPv4(raw)) {
    const parts = raw.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(raw)) {
    if (raw === '::' || raw === '::1') return true;
    if (raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('ff')) return true;
    return false;
  }
  return true;
}

export async function validatePublicUrl(urlString, { lookupFn = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    throw new Error('URL 格式非法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 协议（收到 ${url.protocol}）`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`禁止访问本地主机：${hostname}`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`禁止访问私网 IP：${hostname}`);
    return { url, address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }
  const records = await lookupFn(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`DNS 解析无结果：${hostname}`);
  }
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error(`禁止访问解析到私网的域名：${hostname} -> ${rec.address}`);
    }
  }
  const v4 = records.find((r) => r.family === 4);
  const picked = v4 ?? records[0];
  return { url, address: picked.address, family: picked.family };
}

export async function safeFetch(urlString, {
  maxChars = 40000,
  maxBytes = 2 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 4,
  lookupFn = dns.lookup,
  _requestFn,
} = {}) {
  let currentUrl = String(urlString);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await validatePublicUrl(currentUrl, { lookupFn });
    const { url, address, family } = resolved;
    const isHttps = url.protocol === 'https:';
    const requester = _requestFn ?? (isHttps ? https.request : http.request);

    const res = await new Promise((resolve, reject) => {
      const req = requester({
        host: address,
        family,
        port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Host: url.host,
          'User-Agent': 'chat-relay-fetch/1.0',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
        ...(isHttps ? { servername: url.hostname } : {}),
      }, (resp) => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          resp.resume();
          resolve({ redirect: new URL(resp.headers.location, url).toString() });
          return;
        }
        const chunks = [];
        let bytes = 0;
        resp.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= maxBytes) chunks.push(chunk);
          else resp.destroy();
        });
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, maxChars);
          resolve({ status: resp.statusCode || 200, url: url.toString(), text });
        });
        resp.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('safeFetch 请求超时')));
      req.end();
    });

    if (res.redirect) {
      currentUrl = res.redirect;
      continue;
    }
    return res;
  }
  throw new Error('safeFetch 重定向次数过多');
}

export async function webSearch(query, { maxResults = 6, timeoutMs = 15000 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词不能为空');
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await safeFetch(searchUrl, { maxChars: 120000, timeoutMs });
  const results = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of res.text.matchAll(linkRe)) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const href = m[1].replace(/&amp;/g, '&');
    if (title && href) results.push({ title, url: href });
    if (results.length >= maxResults) break;
  }
  return { ok: true, query: q, results };
}
