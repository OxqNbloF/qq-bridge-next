// 外部控制面 API 与静态控制台服务（x-control-secret 鉴权，Agent 无法触碰）
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOM_MODES, redactSettingsSecrets } from '../config/schema.js';
import { normalizeRoomId, resolveRoomExecution } from '../security/perimeter.js';
import { atomicWriteText, ensureDir } from '../storage/fs-atomic.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function resolveControlSecret({ configSecret = '', dataDir = '' } = {}) {
  const inline = String(configSecret ?? '').trim();
  if (inline) return { secret: inline, source: 'config' };
  if (dataDir) {
    ensureDir(dataDir);
    const filePath = path.join(dataDir, 'control.secret');
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8').trim();
      if (existing) return { secret: existing, source: 'file', filePath };
    }
    const generated = crypto.randomBytes(24).toString('hex');
    atomicWriteText(filePath, `${generated}\n`, { mode: 0o600 });
    return { secret: generated, source: 'generated_file', filePath };
  }
  return { secret: crypto.randomBytes(24).toString('hex'), source: 'ephemeral' };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
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

function timingSafeMatch(expected, candidate) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(candidate || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createControlServer({
  settingsStore,
  roomStore,
  engineRegistry,
  pacing,
  transport,
  dataDir = '',
  webDir = '',
  manifests = new Map(),
  personaVault = null,
  memberGuard = null,
  glossaryVault = null,
  directory = null,
  emoticonVault = null,
  audioVault = null,
  activityFeed = () => [],
  log = () => {},
}) {
  const secretInfo = resolveControlSecret({
    configSecret: settingsStore.get()?.controlPlane?.secret,
    dataDir,
  });

  function currentSecret() {
    const live = String(settingsStore.get()?.controlPlane?.secret ?? '').trim();
    return live || secretInfo.secret;
  }

  function decodeRoomParam(raw) {
    const decoded = decodeURIComponent(String(raw ?? ''));
    const roomId = normalizeRoomId(decoded);
    if (!roomId) throw Object.assign(new Error(`房间 ID 格式非法：${decoded}`), { statusCode: 400 });
    return roomId;
  }

  function serveStatic(reqPath, res) {
    if (!webDir) { sendJson(res, 404, { ok: false, error: '未配置控制台前端目录' }); return; }
    const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const resolved = path.resolve(webDir, rel);
    const rootResolved = path.resolve(webDir);
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const content = fs.readFileSync(resolved);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'content-length': content.length,
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:",
      'x-content-type-options': 'nosniff',
    });
    res.end(content);
  }

  async function handleApi(method, pathname, query, req, res) {
    const provided = req.headers['x-control-secret'];
    if (!timingSafeMatch(currentSecret(), provided)) {
      sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '缺少或错误的 x-control-secret' });
      return;
    }

    const cfg = settingsStore.get();

    if (method === 'GET' && pathname === '/api/control/overview') {
      sendJson(res, 200, {
        ok: true,
        secretSource: cfg.controlPlane.secret ? 'config' : secretInfo.source,
        transport: transport?.getStatus?.() ?? { connected: false },
        activeEngine: cfg.engine,
        roomCount: roomStore.list().length,
        capabilities: cfg.toolbox.enabledCapabilities,
        settings: redactSettingsSecrets(cfg),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/control/engines') {
      sendJson(res, 200, {
        ok: true,
        active: cfg.engine.active,
        model: cfg.engine.model,
        engines: await engineRegistry.listEngines(),
      });
      return;
    }

    const engineSub = /^\/api\/control\/engines\/([^/]+)\/(models|health)$/.exec(pathname);
    if (method === 'GET' && engineSub) {
      const id = decodeURIComponent(engineSub[1]);
      if (engineSub[2] === 'models') {
        sendJson(res, 200, { ok: true, ...(await engineRegistry.listModels(id)) });
      } else {
        sendJson(res, 200, { engineId: id, ...(await engineRegistry.probeHealth(id)) });
      }
      return;
    }

    if ((method === 'PUT' || method === 'POST') && pathname === '/api/control/active-engine') {
      const body = await readJsonBody(req);
      const updated = engineRegistry.switchEngine({
        engineId: body.engineId,
        model: body.model,
        roomId: body.roomId ? decodeRoomParam(body.roomId) : '',
      });
      sendJson(res, 200, { ok: true, activeEngine: updated });
      return;
    }

    if (method === 'GET' && pathname === '/api/control/settings') {
      sendJson(res, 200, { ok: true, settings: redactSettingsSecrets(cfg) });
      return;
    }

    if (method === 'PATCH' && pathname === '/api/control/settings') {
      const body = await readJsonBody(req);
      const updated = settingsStore.patch(body);
      sendJson(res, 200, { ok: true, settings: redactSettingsSecrets(updated) });
      return;
    }

    if (method === 'GET' && pathname === '/api/control/capabilities') {
      const available = [...manifests.values()].map((entry) => ({
        name: entry.manifest.name,
        scope: entry.manifest.scope,
        summary: entry.manifest.summary,
        network: entry.manifest.network,
        actions: Object.keys(entry.manifest.actions),
      }));
      sendJson(res, 200, {
        ok: true,
        enabledCapabilities: [...cfg.toolbox.enabledCapabilities],
        available,
      });
      return;
    }

    if (method === 'PUT' && pathname === '/api/control/capabilities') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.enabledCapabilities)) {
        sendJson(res, 400, { ok: false, error: 'enabledCapabilities 必须是字符串数组' });
        return;
      }
      const nextCaps = [...new Set(body.enabledCapabilities.map((x) => String(x ?? '').trim()).filter(Boolean))];
      const updated = settingsStore.patch({ toolbox: { enabledCapabilities: nextCaps } });
      sendJson(res, 200, { ok: true, enabledCapabilities: updated.toolbox.enabledCapabilities });
      return;
    }

    if (method === 'GET' && pathname === '/api/control/activity') {
      sendJson(res, 200, { ok: true, items: activityFeed() });
      return;
    }

    if (method === 'GET' && pathname === '/api/control/rooms') {
      const storedMap = new Map(roomStore.list().map((r) => [r.roomId, r]));
      const allIds = new Set([...storedMap.keys(), ...Object.keys(cfg.routing.rooms || {})]);
      const rooms = [...allIds].sort().map((roomId) => {
        const exec = resolveRoomExecution(cfg, roomId);
        const st = storedMap.get(roomId);
        return {
          roomId,
          mode: exec.mode,
          paused: exec.paused,
          engineId: exec.engineId,
          model: exec.model,
          personaNote: exec.personaNote,
          intro: personaVault?.getRoomIntro?.(roomId) ?? '',
          seq: st?.seq ?? 0,
          readCursor: st?.readCursor ?? 0,
          unreadCount: st?.unread?.length ?? 0,
          rhythm: st?.rhythm ?? null,
          usage: st?.usage ?? null,
          lastTriggerAt: st?.lastTriggerAt ?? 0,
          lastReplyAt: st?.lastReplyAt ?? 0,
        };
      });
      sendJson(res, 200, { ok: true, rooms });
      return;
    }

    const roomAction = /^\/api\/control\/rooms\/([^/]+)\/(trigger|reset|intro)$/.exec(pathname);
    if (roomAction) {
      const roomId = decodeRoomParam(roomAction[1]);
      const action = roomAction[2];
      const body = await readJsonBody(req);
      if (action === 'trigger' && method === 'POST') {
        const resTrigger = await pacing?.triggerNow?.(roomId, body.reason || 'control_manual');
        sendJson(res, 200, { ok: true, roomId, result: resTrigger ?? { ok: true } });
        return;
      }
      if (action === 'reset' && method === 'POST') {
        await engineRegistry.resetRoomSession(roomId, body.engineId || '');
        roomStore.resetRoom(roomId);
        sendJson(res, 200, { ok: true, roomId });
        return;
      }
      if (action === 'intro' && method === 'PUT') {
        if (!personaVault) { sendJson(res, 501, { ok: false, error: '未启用人设库' }); return; }
        const intro = personaVault.setRoomIntro(roomId, body.intro ?? '');
        sendJson(res, 200, { ok: true, roomId, intro });
        return;
      }
    }

    const roomPatch = /^\/api\/control\/rooms\/([^/]+)$/.exec(pathname);
    if (method === 'PATCH' && roomPatch) {
      const roomId = decodeRoomParam(roomPatch[1]);
      const body = await readJsonBody(req);
      if (body.mode !== undefined && !ROOM_MODES.includes(body.mode)) {
        sendJson(res, 400, { ok: false, error: `非法房间模式：${body.mode}` });
        return;
      }
      const existing = cfg.routing.rooms[roomId] ?? {};
      const next = { ...existing };
      for (const field of ['mode', 'engine', 'model', 'paused', 'personaNote']) {
        if (body[field] === null) delete next[field];
        else if (body[field] !== undefined) next[field] = body[field];
      }
      const updated = settingsStore.patch({ routing: { rooms: { [roomId]: next } } });
      sendJson(res, 200, { ok: true, room: resolveRoomExecution(updated, roomId) });
      return;
    }

    // 人设卡管理
    if (personaVault && pathname === '/api/control/personas') {
      if (method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          active: personaVault.getActivePersona().name,
          items: personaVault.listPersonas(),
          intros: personaVault.listRoomIntros(),
        });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const saved = personaVault.savePersona(body.name, body.content);
        sendJson(res, 200, { ok: true, persona: saved });
        return;
      }
    }
    if (personaVault && method === 'PUT' && pathname === '/api/control/personas/active') {
      const body = await readJsonBody(req);
      const active = personaVault.setActivePersona(body.name ?? '');
      sendJson(res, 200, { ok: true, active: active.name });
      return;
    }
    const personaNameMatch = /^\/api\/control\/personas\/([^/]+)$/.exec(pathname);
    if (personaVault && personaNameMatch) {
      const pName = decodeURIComponent(personaNameMatch[1]);
      if (method === 'GET') {
        const item = personaVault.getPersona(pName);
        if (!item) { sendJson(res, 404, { ok: false, error: '人设不存在' }); return; }
        sendJson(res, 200, { ok: true, persona: item });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { ok: true, deleted: personaVault.deletePersona(pName) });
        return;
      }
    }

    // 成员策略
    if (memberGuard && method === 'GET' && pathname === '/api/control/member-rules') {
      sendJson(res, 200, { ok: true, enabled: cfg.memberPolicy.enabled, groups: memberGuard.listGroupRules() });
      return;
    }
    const memberEntryMatch = /^\/api\/control\/member-rules\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
    if (memberGuard && memberEntryMatch) {
      const groupId = decodeURIComponent(memberEntryMatch[1]);
      const memberId = decodeURIComponent(memberEntryMatch[2]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, rule: memberGuard.setMemberCapabilities(groupId, memberId, body) });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { ok: true, deleted: memberGuard.removeMemberRule(groupId, memberId) });
        return;
      }
    }
    const memberGroupMatch = /^\/api\/control\/member-rules\/([^/]+)$/.exec(pathname);
    if (memberGuard && method === 'PUT' && memberGroupMatch) {
      const groupId = decodeURIComponent(memberGroupMatch[1]);
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, rule: memberGuard.setGroupRule(groupId, body) });
      return;
    }

    // 群术语词典
    if (glossaryVault && pathname === '/api/control/glossary') {
      if (method === 'GET') {
        const roomId = query.get('roomId') || '';
        const limit = Number(query.get('limit')) || 100;
        sendJson(res, 200, { ok: true, items: glossaryVault.list(roomId, { includeGlobal: true, limit }) });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const item = glossaryVault.put(body.roomId || '', body);
        sendJson(res, 200, { ok: true, item });
        return;
      }
    }
    const glossaryIdMatch = /^\/api\/control\/glossary\/([^/]+)$/.exec(pathname);
    if (glossaryVault && method === 'DELETE' && glossaryIdMatch) {
      sendJson(res, 200, { ok: true, deleted: glossaryVault.remove(decodeURIComponent(glossaryIdMatch[1])) });
      return;
    }

    // 成员名录
    if (directory) {
      if (method === 'GET' && pathname === '/api/control/directory') {
        sendJson(res, 200, { ok: true, members: directory.snapshot() });
        return;
      }
      if (pathname === '/api/control/directory/alias') {
        const body = await readJsonBody(req);
        if (method === 'POST') {
          sendJson(res, 200, { ok: true, member: directory.addAlias(body) });
          return;
        }
        if (method === 'DELETE') {
          sendJson(res, 200, { ok: true, removed: directory.removeAlias(body) });
          return;
        }
      }
    }

    // 表情库
    if (emoticonVault) {
      if (method === 'GET' && pathname === '/api/control/emoticons') {
        const roomId = query.get('roomId') || '';
        const q = query.get('query') || '';
        const limit = Number(query.get('limit')) || 50;
        sendJson(res, 200, { ok: true, items: emoticonVault.list(roomId, { query: q, limit }) });
        return;
      }
      if (method === 'POST' && pathname === '/api/control/emoticons/sync') {
        sendJson(res, 200, await emoticonVault.syncFromTransport(transport));
        return;
      }
      const emoMatch = /^\/api\/control\/emoticons\/([^/]+)$/.exec(pathname);
      if (method === 'PATCH' && emoMatch) {
        const body = await readJsonBody(req);
        const item = emoticonVault.annotate(decodeURIComponent(emoMatch[1]), body.roomId || 'global', body.note ?? '');
        sendJson(res, 200, { ok: true, item });
        return;
      }
    }

    // 语音素材
    if (audioVault && method === 'GET' && pathname === '/api/control/audio') {
      sendJson(res, 200, { ok: true, files: audioVault.listAudio() });
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知控制接口: ${method} ${pathname}` });
  }

  let server = null;
  let boundPort = 0;

  async function start() {
    if (server) return { port: boundPort, secret: currentSecret() };
    const cp = settingsStore.get().controlPlane;
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname.startsWith('/api/control/')) {
          await handleApi(req.method || 'GET', url.pathname, url.searchParams, req, res);
        } else {
          serveStatic(url.pathname, res);
        }
      } catch (error) {
        const code = Number(error?.statusCode) || 500;
        if (code >= 500) log?.(`[control-plane] 请求异常: ${error?.message ?? error}`);
        sendJson(res, code, { ok: false, error: error?.message ?? String(error) });
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cp.port, cp.host, () => {
        server.removeListener('error', reject);
        boundPort = server.address()?.port ?? cp.port;
        resolve();
      });
    });

    log?.(`🎛️ 外部控制面板已监听 http://${cp.host}:${boundPort}`);
    return { port: boundPort, host: cp.host, secret: currentSecret(), secretSource: secretInfo.source };
  }

  async function stop() {
    if (!server) return;
    const srv = server;
    server = null;
    await new Promise((resolve) => {
      try { srv.closeAllConnections?.(); } catch {}
      srv.close(() => resolve());
    });
  }

  return {
    start,
    stop,
    getSecret: currentSecret,
    getPort: () => boundPort,
  };
}
