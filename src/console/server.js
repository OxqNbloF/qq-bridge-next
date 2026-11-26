// 外部家长控制 Web 控制台服务端（仅 127.0.0.1 回环 + Host 校验 + 严格 CSP + 时序安全令牌）
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { maskConfigSecrets } from '../config/schema.js';
import { atomicWriteText, ensureDir } from '../storage/fs-atomic.js';
import { canonicalConvKey, resolveChatRuntime } from '../security/access.js';
import { loadModuleManifests } from '../broker/manifest.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function safeEqualToken(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': CSP_HEADER,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function resolveConsoleToken({ configToken = '', dataDir = '' } = {}) {
  if (configToken && String(configToken).trim()) return String(configToken).trim();
  if (dataDir) {
    ensureDir(dataDir);
    const tokenFile = path.join(dataDir, 'console.token');
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    } catch {}
    const generated = crypto.randomBytes(24).toString('hex');
    atomicWriteText(tokenFile, `${generated}\n`, { mode: 0o600 });
    return generated;
  }
  return crypto.randomBytes(24).toString('hex');
}

export function createConsoleServer({
  configStore,
  chatStore,
  backendRegistry,
  scheduler,
  turnQueue,
  socketHub,
  onebot,
  modulesDir,
  webDir,
  dataDir = '',
  getActivity = () => [],
  log = () => {},
}) {
  let server = null;
  let activeToken = resolveConsoleToken({ configToken: configStore.get().console.token, dataDir });
  configStore.onChange((next) => {
    if (next.console.token) activeToken = next.console.token;
  });

  function serveStatic(res, reqPath) {
    const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    if (!webDir || cleanRel.includes('..') || path.isAbsolute(cleanRel)) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const target = path.resolve(webDir, cleanRel);
    const baseDir = path.resolve(webDir);
    if (!target.startsWith(baseDir + path.sep) && target !== path.join(baseDir, 'index.html')) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const ext = path.extname(target);
    const content = fs.readFileSync(target);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'content-security-policy': CSP_HEADER,
      'x-content-type-options': 'nosniff',
      'content-length': content.length,
    });
    res.end(content);
  }

  async function handleApi(req, res, url) {
    if (!safeEqualToken(req.headers['x-console-token'], activeToken)) {
      sendJson(res, 401, { ok: false, error: '未授权：缺少或无效的 x-console-token' });
      return;
    }

    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/api/console/overview') {
      const cfg = configStore.get();
      sendJson(res, 200, {
        ok: true,
        runtime: cfg.runtime,
        onebot: onebot.getStatus(),
        queue: turnQueue.stats(),
        chatsCount: chatStore.list().length,
        enabledModules: cfg.broker.enabledModules,
        socketCount: socketHub.sockets.size,
      });
      return;
    }

    if (method === 'GET' && p === '/api/console/backends') {
      sendJson(res, 200, { ok: true, backends: await backendRegistry.listBackends() });
      return;
    }

    const modelsMatch = /^\/api\/console\/backends\/([a-z0-9_-]+)\/models$/.exec(p);
    if (method === 'GET' && modelsMatch) {
      const info = await backendRegistry.listModels(modelsMatch[1]);
      sendJson(res, 200, { ok: true, ...info });
      return;
    }

    const healthMatch = /^\/api\/console\/backends\/([a-z0-9_-]+)\/health$/.exec(p);
    if (method === 'POST' && healthMatch) {
      const health = await backendRegistry.checkHealth(healthMatch[1]);
      sendJson(res, 200, { ok: true, backendId: healthMatch[1], ...health });
      return;
    }

    if (method === 'POST' && p === '/api/console/runtime') {
      const body = await readJsonBody(req);
      const updated = backendRegistry.switchRuntime({
        backendId: body.backendId,
        model: body.model,
        convKey: body.convKey || '',
      });
      sendJson(res, 200, { ok: true, runtime: updated });
      return;
    }

    if (method === 'GET' && p === '/api/console/config') {
      sendJson(res, 200, { ok: true, config: maskConfigSecrets(configStore.get()) });
      return;
    }

    if (method === 'PATCH' && p === '/api/console/config') {
      const body = await readJsonBody(req);
      const next = configStore.patch(body);
      sendJson(res, 200, { ok: true, config: maskConfigSecrets(next) });
      return;
    }

    if (method === 'GET' && p === '/api/console/chats') {
      const cfg = configStore.get();
      const keys = new Set([...chatStore.list().map((s) => s.convKey), ...Object.keys(cfg.modes.chats ?? {})]);
      const items = [...keys].sort().map((convKey) => {
        const st = chatStore.get(convKey);
        const rt = resolveChatRuntime(cfg, convKey);
        return {
          convKey,
          mode: rt.mode,
          paused: rt.paused,
          backendId: rt.backendId,
          model: rt.model,
          override: cfg.modes.chats?.[convKey] ?? null,
          unreadCount: st?.unread?.length ?? 0,
          readThroughSeq: st?.readThroughSeq ?? 0,
          usage: st?.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 },
          lastWakeAt: st?.lastWakeAt ?? 0,
          lastReplyAt: st?.lastReplyAt ?? 0,
          recentTail: (st?.recent ?? []).slice(-3),
        };
      });
      sendJson(res, 200, { ok: true, chats: items });
      return;
    }

    const chatActionMatch = /^\/api\/console\/chats\/([^/]+)(?:\/(wake|reset))?$/.exec(p);
    if (chatActionMatch) {
      const convKey = canonicalConvKey(decodeURIComponent(chatActionMatch[1]));
      if (!convKey) {
        sendJson(res, 400, { ok: false, error: '非法会话 key' });
        return;
      }
      const action = chatActionMatch[2] || '';
      if (method === 'PATCH' && !action) {
        const body = await readJsonBody(req);
        if (body === null || body.clearOverride === true) {
          configStore.patch({ modes: { chats: { [convKey]: null } } });
        } else {
          configStore.patch({ modes: { chats: { [convKey]: body } } });
        }
        sendJson(res, 200, { ok: true, runtime: resolveChatRuntime(configStore.get(), convKey) });
        return;
      }
      if (method === 'POST' && action === 'wake') {
        void scheduler.wakeNow(convKey, 'console_manual');
        sendJson(res, 200, { ok: true, convKey, woken: true });
        return;
      }
      if (method === 'POST' && action === 'reset') {
        turnQueue.cancelChat(convKey);
        scheduler.cancelChatTimers(convKey);
        await backendRegistry.resetChatSession(convKey);
        socketHub.revokeSocket(convKey);
        chatStore.resetChat(convKey);
        sendJson(res, 200, { ok: true, convKey, reset: true });
        return;
      }
    }

    if (method === 'GET' && p === '/api/console/modules') {
      const cfg = configStore.get();
      const enabledSet = new Set(cfg.broker.enabledModules ?? []);
      const manifests = loadModuleManifests(modulesDir);
      const modules = [...manifests.values()].map((entry) => ({
        name: entry.manifest.name,
        scope: entry.manifest.scope,
        summary: entry.manifest.summary,
        network: entry.manifest.network,
        enabled: enabledSet.has(entry.manifest.name),
        actions: Object.keys(entry.manifest.actions),
      }));
      sendJson(res, 200, { ok: true, enabledModules: cfg.broker.enabledModules, modules });
      return;
    }

    if (method === 'PUT' && p === '/api/console/modules') {
      const body = await readJsonBody(req);
      const list = Array.isArray(body?.enabledModules) ? body.enabledModules.map(String) : null;
      if (!list) {
        sendJson(res, 400, { ok: false, error: 'enabledModules 必须是字符串数组' });
        return;
      }
      const next = configStore.patch({ broker: { enabledModules: list } });
      sendJson(res, 200, { ok: true, enabledModules: next.broker.enabledModules });
      return;
    }

    if (method === 'GET' && p === '/api/console/activity') {
      sendJson(res, 200, { ok: true, items: getActivity() });
      return;
    }

    sendJson(res, 404, { ok: false, error: '未知控制台接口' });
  }

  async function start() {
    if (server) return { port: server.address()?.port, token: activeToken };
    const cfg = configStore.get();
    server = http.createServer(async (req, res) => {
      if (!isAllowedHost(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: '禁止非回环 Host 访问控制台' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/console')) {
        try { await handleApi(req, res, url); }
        catch (error) {
          sendJson(res, Number(error?.statusCode) || 500, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }
      serveStatic(res, url.pathname);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.console.port, cfg.console.host || '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const port = server.address()?.port;
    log(`🛡️ 外部家长控制面板已启动: http://${cfg.console.host}:${port}`);
    return { port, token: activeToken };
  }

  async function stop() {
    if (!server) return;
    const s = server;
    server = null;
    try { s.closeAllConnections?.(); } catch {}
    await new Promise((resolve) => s.close(resolve));
  }

  return { start, stop, getToken: () => activeToken };
}
