// 访问控制、每会话模式与共享运行时（Backend/Model）解析

const CONV_KEY_RE = /^(group|private):(\d{1,20})$/;

export function canonicalConvKey(raw) {
  const m = CONV_KEY_RE.exec(String(raw ?? '').trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

export function parseConvKey(raw) {
  const m = CONV_KEY_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { chatType: m[1], targetId: m[2], convKey: `${m[1]}:${m[2]}` };
}

export function isSenderIgnored(cfg, userId) {
  const uid = String(userId ?? '').trim();
  if (!uid) return false;
  return Array.isArray(cfg?.access?.ignoreUsers) && cfg.access.ignoreUsers.includes(uid);
}

export function isChatAllowed(cfg, convKey) {
  const parsed = parseConvKey(convKey);
  if (!parsed) return false;
  const access = cfg?.access ?? {};
  const allowGroups = Array.isArray(access.allowGroups) ? access.allowGroups : [];
  const allowPrivate = Array.isArray(access.allowPrivate) ? access.allowPrivate : [];
  const denyGroups = Array.isArray(access.denyGroups) ? access.denyGroups : [];
  const denyPrivate = Array.isArray(access.denyPrivate) ? access.denyPrivate : [];

  if (parsed.chatType === 'group') {
    if (denyGroups.includes(parsed.targetId)) return false;
    if (allowGroups.length > 0) return allowGroups.includes(parsed.targetId);
    if (allowPrivate.length > 0) return false;
    return access.allowAllWhenEmpty === true;
  }

  if (denyPrivate.includes(parsed.targetId)) return false;
  if (cfg?.ownerQQ && String(cfg.ownerQQ) === parsed.targetId) return true;
  if (allowPrivate.length > 0) return allowPrivate.includes(parsed.targetId);
  if (allowGroups.length > 0) return false;
  return access.allowAllWhenEmpty === true;
}

export function resolveChatMode(cfg, convKey) {
  const parsed = parseConvKey(convKey);
  if (!parsed) return 'off';
  const override = cfg?.modes?.chats?.[parsed.convKey];
  if (override?.mode) return override.mode;
  return parsed.chatType === 'group'
    ? (cfg?.modes?.defaultGroup ?? 'human')
    : (cfg?.modes?.defaultPrivate ?? 'chat');
}

export function resolveChatRuntime(cfg, convKey) {
  const canonical = canonicalConvKey(convKey);
  const override = canonical ? (cfg?.modes?.chats?.[canonical] ?? {}) : {};
  const mode = canonical ? resolveChatMode(cfg, canonical) : 'off';
  const backendId = override.backend || cfg?.runtime?.activeBackend || 'agy';

  const backendDefaultModel = (() => {
    if (backendId === 'dsh') return cfg?.backends?.dsh?.model || '';
    if (backendId === 'agy') return cfg?.backends?.agy?.model || '';
    if (backendId === 'gemini') return cfg?.backends?.gemini?.model || '';
    return cfg?.backends?.cliProfiles?.[backendId]?.model || '';
  })();

  const model = override.model || cfg?.runtime?.activeModel || backendDefaultModel || '';
  return {
    convKey: canonical,
    mode,
    paused: override.paused === true,
    backendId,
    model,
    personaOverride: override.personaOverride || '',
    scope: mode === 'admin' ? 'admin' : 'chat',
  };
}
