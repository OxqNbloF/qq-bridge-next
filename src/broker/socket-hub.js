// 每会话 Unix Domain Socket 能力中心：Socket 即身份与权限，零 Token 与零跨群参数暴露
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { canonicalConvKey, isChatAllowed, resolveChatMode } from '../security/access.js';

const MAX_UNIX_PATH = 90;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(Object.assign(new Error('JSON 格式非法'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createSocketHub({ getConfig, dataDir = '', handlers = {}, log = () => {} }) {
  const sockets = new Map(); // convKey -> { socketPath, server, scope }

  function resolveSocketDir() {
    const preferred = path.join(dataDir || os.tmpdir(), 'sockets');
    const sample = path.join(preferred, `s_${'0'.repeat(32)}.sock`);
    if (Buffer.byteLength(sample, 'utf8') <= MAX_UNIX_PATH) return preferred;
    const tag = crypto.createHash('sha1').update(String(dataDir || os.tmpdir())).digest('hex').slice(0, 8);
    return path.join(os.tmpdir(), `qqb3-${tag}`);
  }

  async function ensureSocket(rawKey) {
    const convKey = canonicalConvKey(rawKey);
    if (!convKey) throw new Error(`非法会话 key: ${rawKey}`);
    const existing = sockets.get(convKey);
    const scope = resolveChatMode(getConfig(), convKey) === 'admin' ? 'admin' : 'chat';
    if (existing && fs.existsSync(existing.socketPath)) {
      existing.scope = scope;
      return { socketPath: existing.socketPath, scope };
    }
    if (existing) revokeSocket(convKey);

    const sockDir = resolveSocketDir();
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    const socketPath = path.join(sockDir, `s_${crypto.randomBytes(12).toString('hex')}.sock`);

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const route = reqUrl.pathname;
        const cfg = getConfig();

        if (!isChatAllowed(cfg, convKey)) {
          sendJson(res, 403, { ok: false, error: '当前会话不在允许范围内' });
          return;
        }
        const mode = resolveChatMode(cfg, convKey);
        const curScope = mode === 'admin' ? 'admin' : 'chat';

        if (req.method === 'GET' && route === '/broker/policy') {
          sendJson(res, 200, {
            ok: true,
            mode,
            scope: curScope,
            enabledModules: [...(cfg.broker?.enabledModules ?? [])],
            scriptTimeoutMs: cfg.broker?.scriptTimeoutMs ?? 20000,
            limits: {
              maxBurstMessages: cfg.security?.maxBurstMessages ?? 4,
              rateLimitPerMinute: cfg.security?.rateLimitPerMinute ?? 20,
            },
          });
          return;
        }

        if (req.method === 'POST' && route === '/broker/action') {
          const payload = await readJsonBody(req);
          const modName = String(payload?.module ?? '').trim();
          const action = String(payload?.action ?? '').trim();
          const args = isPlainObject(payload?.args) ? payload.args : {};

          // 家长控制实时裁切：禁用模块立刻返回 403
          if (!modName || !(cfg.broker?.enabledModules ?? []).includes(modName)) {
            sendJson(res, 403, {
              ok: false,
              code: 'MODULE_DISABLED_BY_PARENT',
              error: `控制台家长控制已禁用模块：${modName || '未知'}`,
            });
            return;
          }

          const handlerKey = `${modName}.${action}`;
          const fn = handlers[handlerKey];
          if (typeof fn !== 'function') {
            sendJson(res, 404, { ok: false, code: 'UNKNOWN_ACTION', error: `未注册的模块动作：${handlerKey}` });
            return;
          }

          // 强制注入闭包锁定的 convKey，彻底忽略调用方任何 key/convKey 伪造字段
          const result = await fn({ convKey, scope: curScope, args });
          sendJson(res, result?.ok === false && result?.status ? result.status : 200, {
            ...(result && typeof result === 'object' ? result : { ok: true, data: result }),
            convKey,
          });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        log(`[socket-hub] 请求处理异常 (${convKey}): ${error?.message ?? error}`);
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

    sockets.set(convKey, { socketPath, server, scope });
    return { socketPath, scope };
  }

  function revokeSocket(rawKey) {
    const convKey = canonicalConvKey(rawKey) ?? String(rawKey ?? '');
    const entry = sockets.get(convKey);
    if (!entry) return false;
    sockets.delete(convKey);
    try { entry.server.closeAllConnections?.(); } catch {}
    try { entry.server.close(); } catch {}
    try { fs.rmSync(entry.socketPath, { force: true }); } catch {}
    return true;
  }

  function closeAll() {
    for (const k of [...sockets.keys()]) revokeSocket(k);
  }

  return { ensureSocket, revokeSocket, closeAll, sockets };
}
