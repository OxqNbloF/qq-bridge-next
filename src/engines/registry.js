// 统一多引擎注册表：支持免重启热切换（全局或单房间）、选模型与跨引擎交接摘要
import { createDshEngine } from './dsh.js';
import { createAgyEngine } from './agy.js';
import { createGeminiEngine } from './gemini.js';
import { createCustomCliEngine } from './custom-cli.js';
import { resolveRoomExecution } from '../security/perimeter.js';

export function createEngineRegistry({
  settingsStore,
  roomStore,
  spawnFn,
  detectCapsFn,
  dshClientFactory,
  rootDir = process.cwd(),
  log = () => {},
  onUsage,
}) {
  const getConfig = () => settingsStore.get();
  const builtins = {
    dsh: createDshEngine({ getConfig, clientFactory: dshClientFactory, log }),
    agy: createAgyEngine({ getConfig, spawnFn, detectCapsFn, rootDir }),
    gemini: createGeminiEngine({ getConfig, spawnFn, detectCapsFn, rootDir }),
  };
  const customEngines = new Map();

  function syncCustomCli() {
    const map = getConfig()?.engines?.customCli ?? {};
    for (const key of customEngines.keys()) {
      if (!map[key]) customEngines.delete(key);
    }
    for (const profileId of Object.keys(map)) {
      if (!customEngines.has(profileId)) {
        customEngines.set(profileId, createCustomCliEngine({ profileId, getConfig, spawnFn, rootDir }));
      }
    }
  }
  syncCustomCli();

  settingsStore.onChange(() => {
    syncCustomCli();
    for (const e of Object.values(builtins)) e.updateConfig?.();
  });

  function getEngine(engineId) {
    syncCustomCli();
    return builtins[engineId] ?? customEngines.get(engineId) ?? null;
  }

  async function listEngines() {
    syncCustomCli();
    const cfg = getConfig();
    const activeId = cfg.engine.active;
    const all = [...Object.values(builtins), ...customEngines.values()];
    const out = [];
    for (const eng of all) {
      const modelInfo = await eng.listModels();
      out.push({
        id: eng.id,
        label: eng.label,
        builtin: Boolean(builtins[eng.id]),
        active: eng.id === activeId,
        models: modelInfo.models,
        liveModels: modelInfo.live,
      });
    }
    return out;
  }

  async function listModels(engineId) {
    const targetId = engineId || getConfig().engine.active;
    const eng = getEngine(targetId);
    if (!eng) throw new Error(`未知引擎：${targetId}`);
    return { engineId: targetId, ...(await eng.listModels()) };
  }

  async function probeHealth(engineId) {
    const targetId = engineId || getConfig().engine.active;
    const eng = getEngine(targetId);
    if (!eng) return { ok: false, detail: `未知引擎：${targetId}` };
    return eng.checkHealth();
  }

  function resolveForRoom(roomId) {
    const exec = resolveRoomExecution(getConfig(), roomId);
    const engine = getEngine(exec.engineId);
    if (!engine) throw new Error(`房间 ${roomId} 指定的引擎不可用：${exec.engineId}`);
    return { ...exec, engine };
  }

  function switchEngine({ engineId, model, roomId = '' } = {}) {
    if (engineId && !getEngine(engineId)) throw new Error(`目标引擎不存在：${engineId}`);
    if (roomId) {
      const existing = getConfig().routing.rooms[roomId] ?? {};
      const nextOverride = { ...existing };
      if (engineId !== undefined) {
        if (engineId) nextOverride.engine = engineId;
        else delete nextOverride.engine;
      }
      if (model !== undefined) {
        if (model) nextOverride.model = model;
        else delete nextOverride.model;
      }
      settingsStore.patch({ routing: { rooms: { [roomId]: nextOverride } } });
      return resolveForRoom(roomId);
    }

    const patch = { engine: {} };
    if (engineId !== undefined) patch.engine.active = engineId;
    if (model !== undefined) patch.engine.model = model;
    const updated = settingsStore.patch(patch);
    log(`🔄 全局引擎已热切换：active=${updated.engine.active}, model=${updated.engine.model || '(默认)'}`);
    return { active: updated.engine.active, model: updated.engine.model };
  }

  async function resetRoomSession(roomId, engineId = '', summary = '') {
    const st = roomStore.get(roomId);
    if (summary) roomStore.setHandoffSummary(roomId, summary);
    if (engineId) {
      const prevSid = st?.engineSessions?.[engineId];
      if (prevSid) await getEngine(engineId)?.resetSession?.(prevSid);
      roomStore.clearEngineSession(roomId, engineId);
      return true;
    }
    if (st?.engineSessions) {
      for (const [eId, sid] of Object.entries(st.engineSessions)) {
        if (sid) await getEngine(eId)?.resetSession?.(sid);
      }
    }
    roomStore.clearEngineSession(roomId);
    return true;
  }

  async function executeTurn({
    roomId,
    systemPrompt = '',
    deltaPrompt = '',
    socketPath = '',
    scope = 'standard',
    signal = null,
    onEvent,
  }) {
    const { engineId, model, engine } = resolveForRoom(roomId);
    const st = roomStore.ensure(roomId);
    if (st.lastEngineId && st.lastEngineId !== engineId && !st.handoffSummary) {
      const recentText = st.recent.slice(-4)
        .map((m) => `${m.fromSelf ? '我' : (m.senderName || '成员')}:${String(m.text || '').slice(0, 40)}`)
        .join(' | ');
      if (recentText) roomStore.setHandoffSummary(roomId, `[引擎切换交接 ${st.lastEngineId}→${engineId}] ${recentText}`);
    }

    const externalSessionId = roomStore.getEngineSession(roomId, engineId);
    const summaryPrefix = !externalSessionId ? roomStore.takeHandoffSummary(roomId) : '';
    const effectiveSystem = summaryPrefix ? `${systemPrompt}\n\n【上段对话摘要】\n${summaryPrefix}`.trim() : systemPrompt;

    const result = await engine.executeTurn({
      roomId,
      externalSessionId,
      model,
      systemPrompt: effectiveSystem,
      deltaPrompt,
      socketPath,
      scope,
      signal,
      onEvent,
    });

    if (result?.externalSessionId) roomStore.setEngineSession(roomId, engineId, result.externalSessionId);
    else if (!externalSessionId) roomStore.ensure(roomId).lastEngineId = engineId;

    if (result?.usage) {
      roomStore.recordUsage(roomId, result.usage);
      onUsage?.(roomId, engineId, result.usage);
    }

    return { engineId, model: result?.model || model, ...result };
  }

  return { getEngine, listEngines, listModels, probeHealth, resolveForRoom, switchEngine, resetRoomSession, executeTurn };
}
