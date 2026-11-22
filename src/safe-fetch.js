// 安全的只读网页抓取：拦住内网地址，逐跳检查，限量限时
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

// 给 promise 加超时
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 把合法 IPv6 展开为 8 个 16-bit 整数，支持 :: 压缩与尾部点分 IPv4
function parseIpv6Words(ip) {
  let s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s || s.includes('%')) return null;
  // 若尾部包含点分 IPv4，展开为两个 16-bit 十六进制段
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4 = s.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const octets = v4.split('.').map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (parts.length !== 8) return null;
  const words = new Uint16Array(8);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(parts[i])) return null;
    words[i] = parseInt(parts[i], 16);
  }
  return words;
}

function wordsToIpv4(hi, lo) {
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
}

// 判断 IP 是否为内网或保留地址
export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值必须是有效 IP
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    // Azure WireServer 指向平台服务，各种嵌入形式都要拦
    if (h === '168.63.129.16') return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    const w = parseIpv6Words(h);
    if (!w) return true;
    const z = (from, to) => {
      for (let i = from; i <= to; i += 1) if (w[i] !== 0) return false;
      return true;
    };
    // ::/128 未指定、::1/128 回环
    if (z(0, 6) && (w[7] === 0 || w[7] === 1)) return true;
    // ::/96 (IPv4-compatible)、::ffff:0:0/96 (IPv4-mapped)、::ffff:0:0:0/96 (IPv4-translated)
    if ((z(0, 5) && (w[6] !== 0 || w[7] > 1)) || (z(0, 4) && w[5] === 0xffff) || (z(0, 3) && w[4] === 0xffff && w[5] === 0)) {
      return isPrivateIp(wordsToIpv4(w[6], w[7]));
    }
    // 64:ff9b::/96 (Well-Known NAT64) 与 64:ff9b:1::/48 (Local-Use NAT64)
    if (w[0] === 0x0064 && w[1] === 0xff9b) {
      if (w[2] === 0x0001) return true;
      if (z(2, 5)) return isPrivateIp(wordsToIpv4(w[6], w[7]));
    }
    // 100::/64 Discard-Only
    if (w[0] === 0x0100 && z(1, 3)) return true;
    // fc00::/7 Unique Local
    if ((w[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 Link-Local、fec0::/10 Site-Local (deprecated)
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 Multicast
    if ((w[0] & 0xff00) === 0xff00) return true;
    // 2001::/32 Teredo（内嵌异或 IPv4，整段禁用）
    if (w[0] === 0x2001 && w[1] === 0x0000) return true;
    // 2001:db8::/32 文档保留、2001:2::/48 基准测试、2001:10::/28 ORCHID、2001:20::/28 ORCHIDv2
    if (w[0] === 0x2001) {
      if (w[1] === 0x0db8) return true;
      if (w[1] === 0x0002 && w[2] === 0x0000) return true;
      if ((w[1] & 0xfff0) === 0x0010 || (w[1] & 0xfff0) === 0x0020) return true;
    }
    // 2002::/16 6to4：words[1..2] 嵌入 IPv4，无论是否 :: 压缩都检查
    if (w[0] === 0x2002) {
      if (isPrivateIp(wordsToIpv4(w[1], w[2]))) return true;
    }
    return false;
  }

  return true;
}

/**
 * 把地址排成尝试顺序：IPv4 优先，两族交替
 * @param {object[]} addresses 查出来的地址列表
 * @returns {string[]} 按尝试顺序排列的地址
 */
function orderAddresses(addresses) {
  const v4 = addresses.filter((item) => Number(item?.family) === 4).map((item) => item.address);
  const v6 = addresses.filter((item) => Number(item?.family) === 6).map((item) => item.address);
  const ordered = [];
  const max = Math.max(v4.length, v6.length);
  for (let i = 0; i < max; i += 1) {
    if (v4[i]) ordered.push(v4[i]);
    if (v6[i]) ordered.push(v6[i]);
  }
  return ordered;
}

/** 查主机名对应的地址，全部检查一遍后返回 */
export async function resolveSafeAddresses(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return [h];
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      if (/^198\.(?:18|19)\./.test(address)) {
        throw new Error('域名解析到 198.18.0.0/15 保留地址，已阻止；这可能是 Clash/mihomo 的 fake-ip。'
          + '请使用返回真实公网 IP 的 DNS（如 redir-host），或按代理的 fake-ip-filter 规则让该域名返回真实地址。'
          + '私有/保留地址不会被放行');
      }
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  const ordered = orderAddresses(addresses);
  return ordered.length ? ordered : [addresses[0].address];
}

// 查主机名，返回第一个安全地址
export async function resolveSafeHost(hostname) {
  const [first] = await resolveSafeAddresses(hostname);
  return first;
}

// 检查要抓的网址：协议、主机、端口和地址
export async function validateFetchUrl(raw, opts = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  // 可选端口白名单，与内网地址判定互补
  if (Array.isArray(opts.allowPorts) && opts.allowPorts.length) {
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || !opts.allowPorts.includes(port)) {
      throw new Error(`端口 ${port} 不在允许列表（${opts.allowPorts.join('/')}）内，已阻止`);
    }
  }
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, ip: addresses[0], addresses };
}

const REQUEST_TIMEOUT_MS = 20000;
// 多地址时单次尝试预算，避免坏地址耗光总时限
const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ADDRESS_ATTEMPTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 检查上限是不是正整数
function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

/** 用检查过的地址试抓一次，域名和证书仍按原网址认 */
function attemptOnce(url, address, limit, binary, budgetMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let response;
    // 只结算一次并清掉定时器
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // 记下这次失败，看看要不要换个地址再试
    const fail = (error, retryable) => settle({ ok: false, error, retryable: retryable === true });
    // 记下这次成功的结果
    const done = (result) => settle({ ok: true, result });
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      fail(error, true);
      req?.destroy(error);
      response?.destroy();
    }, budgetMs);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: budgetMs,
      }, (res) => {
        response = res;
        res.on('error', (error) => fail(error, true));
        res.on('aborted', () => fail(new Error('响应体读取中断'), true));
        res.on('close', () => {
          if (!res.complete) fail(new Error('响应体读取中断'), true);
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          done({ statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文，防无限正文耗资源
          res.destroy();
          return;
        }
        const chunks = [];
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        // 按剩余额度追加文本
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            done({ statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) { appendText(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > limit) {
            fail(new Error(`图片超过大小限制（${limit} 字节）`), false);
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) done({ statusCode, buffer: Buffer.concat(chunks) });
          else {
            appendText(decoder.end());
            done({ statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        fail(error, true);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => fail(error, true));
      req.end();
    } catch (error) {
      fail(error, true);
      req?.destroy();
    }
  });
}

/** 把检查过的地址挨个试一遍，都失败就报最后一个错 */
async function requestOnce(url, addresses, limit, binary = false) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError = null;
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break;
    const budget = list.length === 1
      ? REQUEST_TIMEOUT_MS
      : Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    const outcome = await attemptOnce(url, list[i], limit, binary, budget);
    if (outcome.ok) return outcome.result;
    lastError = outcome.error;
    if (!outcome.retryable) throw outcome.error;
    if (i < attempts - 1) {
      // 换地址重试只换连接目标，Host/SNI/路径不变
      continue;
    }
  }
  if (lastError && attempts > 1) {
    lastError.message = `${lastError.message}（已尝试 ${attempts} 个地址）`;
  }
  throw lastError ?? new Error(`请求失败：${url.hostname}`);
}

// 安全抓一段文字，重定向会跟着走并重新检查
export async function safeFetch(urlString, maxChars = 50000, opts = {}) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString, opts);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next, opts));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 只接受 PNG/JPEG/GIF/WebP */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓图片内容，会检查地址安全并确认真的是图片 */
export async function safeFetchBuffer(urlString, maxBytes = 8 * 1024 * 1024, opts = {}) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString, opts);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next, opts));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
