// 访问边界、每房间模式与运行引擎/模型解析

const ROOM_ID_RE = /^(group|direct):(\d{1,20})$/;

export function normalizeRoomId(raw) {
  const m = ROOM_ID_RE.exec(String(raw ?? '').trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

export function parseRoomId(raw) {
  const m = ROOM_ID_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { kind: m[1], peerId: m[2], roomId: `${m[1]}:${m[2]}` };
}

export function isSenderMuted(cfg, senderId) {
  const sid = String(senderId ?? '').trim();
  if (!sid) return false;
  return Array.isArray(cfg?.perimeter?.mutedSenders) && cfg.perimeter.mutedSenders.includes(sid);
}

export function isRoomPermitted(cfg, roomId) {
  const parsed = parseRoomId(roomId);
  if (!parsed) return false;
  const p = cfg?.perimeter ?? {};
  const allowedGroups = Array.isArray(p.allowedGroups) ? p.allowedGroups : [];
  const allowedDirects = Array.isArray(p.allowedDirects) ? p.allowedDirects : [];
  const blockedGroups = Array.isArray(p.blockedGroups) ? p.blockedGroups : [];
  const blockedDirects = Array.isArray(p.blockedDirects) ? p.blockedDirects : [];

  if (parsed.kind === 'group') {
    if (blockedGroups.includes(parsed.peerId)) return false;
    if (allowedGroups.length > 0) return allowedGroups.includes(parsed.peerId);
    if (allowedDirects.length > 0) return false;
    return p.openWhenEmpty === true;
  }

  if (blockedDirects.includes(parsed.peerId)) return false;
  if (cfg?.ownerId && String(cfg.ownerId) === parsed.peerId) return true;
  if (allowedDirects.length > 0) return allowedDirects.includes(parsed.peerId);
  if (allowedGroups.length > 0) return false;
  return p.openWhenEmpty === true;
}

export function resolveRoomMode(cfg, roomId) {
  const parsed = parseRoomId(roomId);
  if (!parsed) return 'muted';
  const override = cfg?.routing?.rooms?.[parsed.roomId];
  if (override?.mode) return override.mode;
  return parsed.kind === 'group'
    ? (cfg?.routing?.defaultGroupMode ?? 'ambient')
    : (cfg?.routing?.defaultDirectMode ?? 'direct');
}

export function resolveRoomExecution(cfg, roomId) {
  const canonical = normalizeRoomId(roomId);
  const override = canonical ? (cfg?.routing?.rooms?.[canonical] ?? {}) : {};
  const mode = canonical ? resolveRoomMode(cfg, canonical) : 'muted';
  const engineId = override.engine || cfg?.engine?.active || 'agy';

  const engineDefaultModel = (() => {
    if (engineId === 'dsh') return cfg?.engines?.dsh?.model || '';
    if (engineId === 'agy') return cfg?.engines?.agy?.model || '';
    if (engineId === 'gemini') return cfg?.engines?.gemini?.model || '';
    return cfg?.engines?.customCli?.[engineId]?.model || '';
  })();

  const model = override.model || cfg?.engine?.model || engineDefaultModel || '';
  return {
    roomId: canonical,
    mode,
    paused: override.paused === true,
    engineId,
    model,
    personaNote: override.personaNote || '',
    scope: mode === 'operator' ? 'admin' : 'standard',
  };
}
