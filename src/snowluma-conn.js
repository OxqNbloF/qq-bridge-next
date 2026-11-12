// SnowLuma 连接自发现：逐个试候选 token，换账号不 401
import fs from 'node:fs';
import path from 'node:path';

/** SnowLuma 主目录候选；兼容完整 config 与窄对象 */
export function snowLumaHomeCandidates({ cfg = null } = {}) {
  const out = [];
  // 加一个不重复的目录
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const sl = cfg?.snowluma ?? cfg ?? {};
  if (sl.homeDir) push(String(sl.homeDir));
  if (sl.launcherPath) push(path.dirname(String(sl.launcherPath)));
  if (process.env.SNOWLUMA_HOME) push(process.env.SNOWLUMA_HOME);
  return out;
}

/** 读每个账号配置里的 HTTP 与 WS token（两者不同） */
export function readOneBotTokens(homeDir) {
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      const nets = j?.networks ?? {};
      const http = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const ws = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      out.push({
        uin: m[1],
        file: path.join(dir, e.name),
        http: http ? { token: String(http.accessToken ?? ''), host: http.host || '127.0.0.1', port: Number(http.port) || 3000 } : null,
        ws: ws ? { token: String(ws.accessToken ?? ''), host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001 } : null
      });
    } catch {
      // 单个文件坏了不影响其它账号
    }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 只取 HTTP token 的扁平列表 */
export function readOneBotHttpTokens(homeDir) {
  return readOneBotTokens(homeDir)
    .filter((a) => a.http)
    .map((a) => ({ token: a.http.token, uin: a.uin, host: a.http.host, port: a.http.port, file: a.file }));
}

/** 试一次 get_login_info，成功返回 data，失败 null */
async function probe(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' || body.retcode !== 0) return { ok: false, status: res.status, retcode: body.retcode, wording: body.wording };
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 找出一条能用的连接
 * @returns {Promise<object>} 能用就用 ok=true 返回连接信息
 */
export async function discoverSnowLumaConnection({
  cfg = null,
  baseUrl = null,
  token = null,
  homeDirs = null,
  timeoutMs = 6000
} = {}) {
  const sl = cfg?.snowluma ?? cfg ?? {};
  const base = String(baseUrl || process.env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homes = homeDirs ?? snowLumaHomeCandidates({ cfg });
  const explicit = token || process.env.SNOWLUMA_TOKEN || sl.accessToken || '';

  // 显式配置优先，再试各账号文件
  const candidates = [];
  const seen = new Set();
  // 加入一个去重的候选 token
  const add = (tk, source, url) => {
    const key = `${url}|${tk}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ token: tk, source, url });
  };
  if (explicit) add(explicit, 'config/env', base);
  // 同时收 HTTP token 和 WS 信息，不能混用
  const wsInfo = new Map();   // uin -> { token, url }
  for (const home of homes) {
    for (const entry of readOneBotTokens(home)) {
      if (entry.http) add(entry.http.token, `onebot_${entry.uin}.json`, `http://${entry.http.host}:${entry.http.port}`);
      if (entry.ws?.token) wsInfo.set(entry.uin, { token: entry.ws.token, url: `ws://${entry.ws.host}:${entry.ws.port}` });
    }
  }
  if (!explicit && candidates.length === 0) add('', 'no-token', base);

  const tried = [];
  for (const c of candidates) {
    const r = await probe(c.url, c.token, timeoutMs);
    tried.push({ source: c.source, url: c.url, token: c.token ? '(已配置)' : '(未配置)', ok: r.ok, status: r.status, wording: r.wording });
    if (r.ok) {
      // 带回同一账号的 WS 信息，否则桥接仍会重连
      const uin = /onebot_(\d+)\.json/.exec(c.source)?.[1] ?? String(r.data?.user_id ?? '');
      const w = wsInfo.get(uin) ?? null;
      return {
        ok: true,
        token: c.token,
        baseUrl: c.url,
        self: r.data,
        source: c.source,
        wsToken: w?.token ?? null,
        wsUrl: w?.url ?? null,
        tried
      };
    }
  }
  const last = tried[tried.length - 1];
  return {
    ok: false,
    tried,
    baseUrl: base,
    error: last?.status === 401
      ? `所有候选 token 都被拒绝（401）。当前账号的 token 可能还没写进 SnowLuma 的 config：请确认 SnowLuma 已登录目标 QQ，且 OneBot HTTP 服务已开启。`
      : `连不上 OneBot HTTP API（${base}）：${last?.wording ?? last?.status ?? '未知错误'}`
  };
}

/** 只写 accessToken；返回 { updated, from, to } */
export function persistToken(cfgPath, newToken) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const old = String(JSON.parse(text).snowluma?.accessToken ?? '');
  const r = persistSnowLumaEndpoint(cfgPath, { accessToken: newToken });
  return { updated: r.updated, from: old, to: newToken };
}

/** 把确认可用的端点写回 config.json，无变化不写 */
export function persistSnowLumaEndpoint(cfgPath, { accessToken, wsUrl, httpUrl } = {}) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  // 读时去掉 BOM，否则 JSON.parse 报错
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  const cfg = JSON.parse(text);
  const cur = cfg.snowluma ?? {};
  const next = { ...cur };
  const changed = {};
  // 字段有变化时记下并更新
  const consider = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (String(cur[key] ?? '') === String(value)) return;
    changed[key] = { from: cur[key] ?? null, to: value };
    next[key] = value;
  };
  consider('accessToken', accessToken);
  consider('wsUrl', wsUrl);
  consider('httpUrl', httpUrl);
  if (Object.keys(changed).length === 0) return { updated: false, changed: {} };
  cfg.snowluma = next;
  // 回写时保留原 BOM，不做额外字节改动
  const serialized = JSON.stringify(cfg, null, 2) + '\n';
  fs.writeFileSync(cfgPath, hadBom ? `\uFEFF${serialized}` : serialized, 'utf8');
  return { updated: true, changed };
}
