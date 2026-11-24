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

/** 列出候选地址：DSH_WEB_URL 优先，其次配置地址，再扫本机 DSH 日志里的最新回环端口与默认端口；已去重 */
export async function listDshCandidateBaseUrls({ current, dshHome } = {}) {
  const candidates = [];
  // 去重加入候选
  const push = (value) => {
    const base = normalizeDshBaseUrl(value);
    if (base && !candidates.includes(base)) candidates.push(base);
  };
  push(process.env.DSH_WEB_URL);
  push(current);
  // 扫描本机 DSH 日志最新 server-*.log 首尾 64KB 提取动态回环端口
  try {
    const fsMod = await import('node:fs');
    const osMod = await import('node:os');
    const pathMod = await import('node:path');
    const home = dshHome || process.env.DSH_HOME || pathMod.join(osMod.homedir(), '.dsh');
    const logDirs = [pathMod.join(home, 'logs'), pathMod.join(home, 'guard', 'logs')];
    const logFiles = [];
    for (const dir of logDirs) {
      if (!fsMod.existsSync(dir)) continue;
      for (const name of fsMod.readdirSync(dir)) {
        if (!/^server-.*\.log$/i.test(name)) continue;
        const full = pathMod.join(dir, name);
        try {
          const st = fsMod.statSync(full);
          if (st.isFile()) logFiles.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
    logFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const SLICE = 65536;
    const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}/gi;
    for (const f of logFiles.slice(0, 3)) {
      try {
        let text = '';
        if (f.size <= SLICE * 2) {
          text = fsMod.readFileSync(f.full, 'utf8');
        } else {
          const fd = fsMod.openSync(f.full, 'r');
          try {
            const head = Buffer.allocUnsafe(SLICE);
            const tail = Buffer.allocUnsafe(SLICE);
            const hRead = fsMod.readSync(fd, head, 0, SLICE, 0);
            const tRead = fsMod.readSync(fd, tail, 0, SLICE, Math.max(0, f.size - SLICE));
            text = `${head.subarray(0, hRead).toString('utf8')}\n${tail.subarray(0, tRead).toString('utf8')}`;
          } finally { fsMod.closeSync(fd); }
        }
        const matches = text.match(URL_RE) || [];
        for (let i = matches.length - 1; i >= 0; i -= 1) push(matches[i]);
      } catch {}
    }
  } catch {}
  push('http://127.0.0.1:3080');
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
