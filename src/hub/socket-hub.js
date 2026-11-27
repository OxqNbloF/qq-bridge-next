// 每房间专属 Unix Domain Socket 能力中心：Socket 即身份与权限，零 Token 与零跨房间伪造参数
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isRoomPermitted, normalizeRoomId, resolveRoomMode } from '../security/perimeter.js';

const MAX_UNIX_PATH = 90;

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

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
  const sockets = new Map(); // roomId -> { socketPath, server, scope }

  function resolveSocketDir() {
    const preferred = path.join(dataDir || os.tmpdir(), 'sockets');
    const sample = path.join(preferred, `s_${'0'.repeat(32)}.sock`);
    if (Buffer.byteLength(sample, 'utf8') <= MAX_UNIX_PATH) return preferred;
    const tag = crypto.createHash('sha1').update(String(dataDir || os.tmpdir())).digest('hex').slice(0, 8);
    return path.join(os.tmpdir(), `relay-sock-${tag}`);
  }

  async function ensureSocket(rawRoomId) {
    const roomId = normalizeRoomId(rawRoomId);
    if (!roomId) throw new Error(`非法房间 ID: ${rawRoomId}`);
    const existing = sockets.get(roomId);
    const scope = resolveRoomMode(getConfig(), roomId) === 'operator' ? 'admin' : 'standard';
    if (existing && fs.existsSync(existing.socketPath)) {
      existing.scope = scope;
      return { socketPath: existing.socketPath, scope };
    }
    if (existing) revokeSocket(roomId);

    const sockDir = resolveSocketDir();
    fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    const socketPath = path.join(sockDir, `s_${crypto.randomBytes(12).toString('hex')}.sock`);

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const route = reqUrl.pathname;
        const cfg = getConfig();

        if (!isRoomPermitted(cfg, roomId)) {
          sendJson(res, 403, { ok: false, error: '当前房间不在允许范围内' });
          return;
        }
        const mode = resolveRoomMode(cfg, roomId);
        const curScope = mode === 'operator' ? 'admin' : 'standard';

        if (req.method === 'GET' && route === '/hub/policy') {
          sendJson(res, 200, {
            ok: true,
            mode,
            scope: curScope,
            enabledCapabilities: [...(cfg.toolbox?.enabledCapabilities ?? [])],
            scriptTimeoutMs: cfg.toolbox?.scriptTimeoutMs ?? 20000,
            limits: {
              maxBurst: cfg.guard?.maxBurst ?? 4,
              maxPerMinute: cfg.guard?.maxPerMinute ?? 20,
            },
          });
          return;
        }

        if (req.method === 'POST' && route === '/hub/exec') {
          const payload = await readJsonBody(req);
          const cap = String(payload?.capability ?? '').trim();
          const action = String(payload?.action ?? '').trim();
          const args = isPlainObject(payload?.args) ? payload.args : {};

          if (!cap || !(cfg.toolbox?.enabledCapabilities ?? []).includes(cap)) {
            sendJson(res, 403, {
              ok: false,
              code: 'CAPABILITY_DISABLED_BY_CONTROL',
              error: `外部控制面板已禁用能力：${cap || '未知'}`,
            });
            return;
          }

          const handlerKey = `${cap}.${action}`;
          const fn = handlers[handlerKey];
          if (typeof fn !== 'function') {
            sendJson(res, 404, { ok: false, code: 'UNKNOWN_ACTION', error: `未注册的能力动作：${handlerKey}` });
            return;
          }

          const result = await fn({ roomId, scope: curScope, args });
          sendJson(res, result?.ok === false && result?.status ? result.status : 200, {
            ...(result && typeof result === 'object' ? result : { ok: true, data: result }),
            roomId,
          });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        log?.(`[socket-hub] 请求处理异常 (${roomId}): ${error?.message ?? error}`);
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

    sockets.set(roomId, { socketPath, server, scope });
    return { socketPath, scope };
  }

  function revokeSocket(rawRoomId) {
    const roomId = normalizeRoomId(rawRoomId) ?? String(rawRoomId ?? '');
    const entry = sockets.get(roomId);
    if (!entry) return false;
    sockets.delete(roomId);
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
