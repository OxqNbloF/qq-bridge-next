// DSH 端口变化时自愈：配置地址探活失败才去找真正在跑的 DSH
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discoverDshSessionCookie, isLoopbackBase } from './dsh-client.js';

/** 单个候选的探测上限，探活循环里必须短 */
const PROBE_TIMEOUT_MS = 1500;
/** 单次最多探测的端口数 */
const MAX_CANDIDATES = 12;

/** 规范化 DSH 基址；非法 http(s) 返回 '' */
export function normalizeDshBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 用离线 Cookie 发 settings/describe，判断地址是否是可用 DSH
 * @returns 该地址是否返回 ok 的 server-response
 */
export async function probeDshBaseUrl(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeDshBaseUrl(baseUrl);
  if (!base || !isLoopbackBase(base)) return false;
  // 没有签名密钥就不探测，否则每个端口都会 401
  const cookie = discoverDshSessionCookie(base);
  if (!cookie) return false;
  const endpoint = 'settings/describe';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${Math.random().toString(36).slice(2, 8)}`,
        method: endpoint,
        payload: { args: {} }
      }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.type === 'server-response' && body?.result?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try { await response?.body?.cancel(); } catch {}
  }
}

/** 列出候选地址：DSH_WEB_URL 优先，其次配置地址；已去重 */
export async function listDshCandidateBaseUrls({ current } = {}) {
  const candidates = [];
  // 去重加入候选
  const push = (value) => {
    const base = normalizeDshBaseUrl(value);
    if (base && !candidates.includes(base)) candidates.push(base);
  };
  push(process.env.DSH_WEB_URL);
  push(current);
  return candidates.slice(0, MAX_CANDIDATES);
}

/** 找到真正在跑的 DSH；要能通过登录检查才算，端口开着不算 */
export async function discoverDshBaseUrl({ current, log = () => {} } = {}) {
  const candidates = await listDshCandidateBaseUrls({ current });
  for (const base of candidates) {
    if (await probeDshBaseUrl(base)) return base;
  }
  if (candidates.length > 1) {
    log(`DSH 端点自愈：试过 ${candidates.length} 个候选地址，没有一个响应 settings/describe`);
  }
  return null;
}

// 手动运行时打印当前真正在跑的 DSH 地址
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 从 config.json 里读配置的 DSH 地址
  const configured = (() => {
    try {
      const file = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
      return file?.dsh?.baseUrl ?? '';
    } catch {
      return '';
    }
  })();
  const found = await discoverDshBaseUrl({ current: configured, log: (message) => console.error(message) });
  console.log(found ?? '');
  process.exitCode = found ? 0 : 1;
}
