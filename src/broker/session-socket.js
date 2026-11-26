// 每会话专属 Unix Domain Socket 能力代理：Socket 即权限，零 Token/零跨群参数暴露给模型与脚本
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { canonicalV2Key } from '../policy/access.js';

const SAFE_AGENT_PATH_RE = /^\/api\/agent\/[a-z0-9/_-]+$/;
const MAX_UNIX_SOCKET_PATH = 90; // macOS sun_path 上限 104 字节，留足余量

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 创建每会话 Unix Domain Socket 能力中心 */
export function createSessionSocketHub(b) {
  const sockets = new Map(); // canonicalKey -> { socketPath, server, scope, createdAt }
  let bridgeEndpoint = null; // { getPort, getConsoleToken }

  function setBridgeEndpoint(endpoint) {
    bridgeEndpoint = endpoint;
  }

  function resolveSocketDir() {
    const preferred = path.join(String(b.STATE_DIR || os.tmpdir()), 'sockets');
    const sample = path.join(preferred, `s_${'0'.repeat(32)}.sock`);
    if (Buffer.byteLength(sample, 'utf8') <= MAX_UNIX_SOCKET_PATH) return preferred;
    const tag = crypto.createHash('sha1').update(String(b.STATE_DIR || os.tmpdir())).digest('hex').slice(0, 8);
    return path.join(os.tmpdir(), `qqb-sock-${tag}`);
  }

  function currentScope(key) {
    return b.modeForKey?.(key) === 'closed-agent' ? 'admin' : 'chat';
  }

  async function forwardToBridge(convKey, { module: modName, method = 'GET', path: agentPath, query, body }) {
    const cleanPath = String(agentPath ?? '').trim();
    if (!cleanPath || cleanPath.includes('..') || !SAFE_AGENT_PATH_RE.test(cleanPath)) {
      return { status: 403, body: { ok: false, error: '禁止访问非 Agent 接口（控制台管理路径不可达）' } };
    }
    const cleanModule = String(modName ?? '').trim();
    const enabled = Array.isArray(b.cfg.broker?.enabledModules) ? b.cfg.broker.enabledModules : [];
    if (!cleanModule || !enabled.includes(cleanModule)) {
      return { status: 403, error: 'MODULE_DISABLED_BY_PARENT', body: { ok: false, code: 'MODULE_DISABLED_BY_PARENT', error: `控制台已禁用模块：${cleanModule || '未知'}` } };
    }
    if (!b.isSessionAllowedInCurrentMode?.(convKey)) {
      return { status: 403, body: { ok: false, error: '当前会话不在允许范围内' } };
    }
    const port = bridgeEndpoint?.getPort?.();
    const consoleToken = bridgeEndpoint?.getConsoleToken?.();
    if (!port || !consoleToken) {
      return { status: 503, body: { ok: false, error: '桥接内部 HTTP 服务尚未就绪' } };
    }
    const st = b.getSocialV2State(convKey);
    const upperMethod = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(upperMethod)) {
      return { status: 405, body: { ok: false, error: '不支持的 HTTP 方法' } };
    }

    const urlObj = new URL(cleanPath, `http://127.0.0.1:${port}`);
    if (upperMethod === 'GET') {
      if (isPlainObject(query)) {
        for (const [k, v] of Object.entries(query)) {
          if (k === 'key' || k === 'token' || v === undefined || v === null) continue;
          urlObj.searchParams.set(k, String(v));
        }
      }
      // 强制覆写 key 为本 Socket 绑定的会话，彻底阻断跨群参数伪造
      urlObj.searchParams.set('key', convKey);
    }

    const forwardBody = upperMethod === 'GET'
      ? undefined
      : JSON.stringify({
        ...(isPlainObject(body) ? body : {}),
        // 强制锁定为本会话，忽略外部传入的任何 key / token
        key: convKey,
      });

    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: upperMethod,
        headers: {
          'x-console-token': consoleToken,
          'x-agent-call': '1',
          'x-agent-token': st.agentToken,
          ...(forwardBody !== undefined ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(forwardBody),
          } : {}),
        },
      }, (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = { ok: false, raw: text }; }
          resolve({ status: upRes.statusCode || 200, body: json });
        });
      });
      req.on('error', (error) => {
        resolve({ status: 502, body: { ok: false, error: `桥接代理请求失败：${error?.message ?? error}` } });
      });
      req.setTimeout(660_000, () => {
        req.destroy(new Error('agent-proxy timeout'));
      });
      if (forwardBody !== undefined) req.write(forwardBody);
      req.end();
    });
  }

  async function ensureSocket(rawKey) {
    const key = canonicalV2Key(rawKey) ?? String(rawKey ?? '').trim();
    if (!key) throw new Error('session-socket: 会话 key 不能为空');
    const existing = sockets.get(key);
    if (existing && fs.existsSync(existing.socketPath)) {
      existing.scope = currentScope(key);
      return { socketPath: existing.socketPath, scope: existing.scope };
    }
    if (existing) revokeSocket(key);

    const sockDir = resolveSocketDir();
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    const socketPath = path.join(sockDir, `s_${crypto.randomBytes(16).toString('hex')}.sock`);

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const sockRoute = reqUrl.pathname;
        if (req.method === 'GET' && sockRoute === '/broker/policy') {
          if (!b.isSessionAllowedInCurrentMode?.(key)) {
            sendJson(res, 403, { ok: false, error: '当前模式不允许此会话' });
            return;
          }
          const scope = currentScope(key);
          const enabledModules = Array.isArray(b.cfg.broker?.enabledModules) ? [...b.cfg.broker.enabledModules] : [];
          sendJson(res, 200, {
            ok: true,
            mode: b.modeForKey?.(key) ?? 'reserved2',
            scope,
            enabledModules,
            tools: { ...(b.cfg.socialV2?.tools ?? {}) },
          });
          return;
        }
        if (req.method === 'POST' && sockRoute === '/broker/agent-proxy') {
          const payload = await readJsonBody(req);
          const result = await forwardToBridge(key, payload);
          sendJson(res, result.status, result.body);
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        sendJson(res, Number(error?.statusCode) || 500, { ok: false, error: error?.message ?? String(error) });
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        server.unref?.();
        resolve();
      });
    });

    const entry = { socketPath, server, scope: currentScope(key), createdAt: Date.now() };
    sockets.set(key, entry);
    return { socketPath, scope: entry.scope };
  }

  function revokeSocket(rawKey) {
    const key = canonicalV2Key(rawKey) ?? String(rawKey ?? '').trim();
    const entry = sockets.get(key);
    if (!entry) return false;
    sockets.delete(key);
    try { entry.server.closeAllConnections?.(); } catch {}
    try { entry.server.close(); } catch {}
    try { fs.rmSync(entry.socketPath, { force: true }); } catch {}
    return true;
  }

  function closeAll() {
    for (const key of [...sockets.keys()]) revokeSocket(key);
  }

  return { setBridgeEndpoint, ensureSocket, revokeSocket, closeAll, sockets };
}
