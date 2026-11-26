// 统一多后端注册表：支持热切换后端与模型（全局或单聊）、保留跨后端上下文平滑交接
import { createDshBackend } from './dsh.js';
import { createAgyBackend } from './agy.js';
import { createGeminiBackend } from './gemini.js';
import { createGenericCliBackend } from './generic-cli.js';
import { resolveChatRuntime } from '../security/access.js';

export function createBackendRegistry({
  configStore,
  chatStore,
  spawnFn,
  detectCapsFn,
  dshClientFactory,
  rootDir = process.cwd(),
  log = () => {},
  onUsage,
}) {
  const getConfig = () => configStore.get();
  const builtins = {
    dsh: createDshBackend({ getConfig, clientFactory: dshClientFactory, log }),
    agy: createAgyBackend({ getConfig, spawnFn, detectCapsFn, rootDir }),
    gemini: createGeminiBackend({ getConfig, spawnFn, detectCapsFn, rootDir }),
  };
  const customBackends = new Map();

  function syncCustomProfiles() {
    const profiles = getConfig()?.backends?.cliProfiles ?? {};
    for (const key of customBackends.keys()) {
      if (!profiles[key]) customBackends.delete(key);
    }
    for (const profileId of Object.keys(profiles)) {
      if (!customBackends.has(profileId)) {
        customBackends.set(profileId, createGenericCliBackend({ profileId, getConfig, spawnFn, rootDir }));
      }
    }
  }
  syncCustomProfiles();

  configStore.onChange(() => {
    syncCustomProfiles();
    for (const b of Object.values(builtins)) b.updateConfig?.();
  });

  function getBackend(backendId) {
    syncCustomProfiles();
    return builtins[backendId] ?? customBackends.get(backendId) ?? null;
  }

  async function listBackends() {
    syncCustomProfiles();
    const cfg = getConfig();
    const activeId = cfg.runtime.activeBackend;
    const all = [...Object.values(builtins), ...customBackends.values()];
    const out = [];
    for (const b of all) {
      const modelInfo = await b.listModels();
      out.push({
        id: b.id,
        label: b.label,
        builtin: Boolean(builtins[b.id]),
        active: b.id === activeId,
        models: modelInfo.models,
        liveModels: modelInfo.live,
      });
    }
    return out;
  }

  async function listModels(backendId) {
    const targetId = backendId || getConfig().runtime.activeBackend;
    const b = getBackend(targetId);
    if (!b) throw new Error(`未知后端：${targetId}`);
    const res = await b.listModels();
    return { backendId: targetId, ...res };
  }

  async function checkHealth(backendId) {
    const targetId = backendId || getConfig().runtime.activeBackend;
    const b = getBackend(targetId);
    if (!b) return { ok: false, detail: `未知后端：${targetId}` };
    return b.checkHealth();
  }

  function resolveForChat(convKey) {
    const cfg = getConfig();
    const runtime = resolveChatRuntime(cfg, convKey);
    const backend = getBackend(runtime.backendId);
    if (!backend) throw new Error(`会话 ${convKey} 指定的后端不可用：${runtime.backendId}`);
    return { ...runtime, backend };
  }

  function switchRuntime({ backendId, model, convKey = '' } = {}) {
    if (backendId && !getBackend(backendId)) {
      throw new Error(`目标后端不存在：${backendId}`);
    }
    if (convKey) {
      const existing = getConfig().modes.chats[convKey] ?? {};
      const nextOverride = { ...existing };
      if (backendId !== undefined) {
        if (backendId) nextOverride.backend = backendId;
        else delete nextOverride.backend;
      }
      if (model !== undefined) {
        if (model) nextOverride.model = model;
        else delete nextOverride.model;
      }
      configStore.patch({ modes: { chats: { [convKey]: nextOverride } } });
      return resolveForChat(convKey);
    }

    const patch = { runtime: {} };
    if (backendId !== undefined) patch.runtime.activeBackend = backendId;
    if (model !== undefined) patch.runtime.activeModel = model;
    const updated = configStore.patch(patch);
    log(`🔄 运行时后端热切换完成：backend=${updated.runtime.activeBackend}, model=${updated.runtime.activeModel || '(默认)'}`);
    return { activeBackend: updated.runtime.activeBackend, activeModel: updated.runtime.activeModel };
  }

  async function resetChatSession(convKey, backendId = '', summary = '') {
    const st = chatStore.get(convKey);
    if (summary) chatStore.setRollingSummary(convKey, summary);
    if (backendId) {
      const prevSid = st?.backendSessions?.[backendId];
      if (prevSid) await getBackend(backendId)?.resetSession?.(prevSid);
      chatStore.clearBackendSession(convKey, backendId);
      return true;
    }
    if (st?.backendSessions) {
      for (const [bId, sid] of Object.entries(st.backendSessions)) {
        if (sid) await getBackend(bId)?.resetSession?.(sid);
      }
    }
    chatStore.clearBackendSession(convKey);
    return true;
  }

  async function runTurn({
    convKey,
    systemPrompt = '',
    deltaPrompt = '',
    socketPath = '',
    scope = 'chat',
    signal = null,
    onEvent,
  }) {
    const { backendId, model, backend } = resolveForChat(convKey);
    const st = chatStore.ensure(convKey);
    // 切换了不同后端时，自动带入最新跨后端上下文摘要，保证共享连续体验
    if (st.lastBackendId && st.lastBackendId !== backendId && !st.rollingSummary) {
      const recentText = st.recent.slice(-4)
        .map((m) => `${m.fromSelf ? '我' : (m.senderName || '成员')}:${String(m.text || '').slice(0, 40)}`)
        .join(' | ');
      if (recentText) chatStore.setRollingSummary(convKey, `[后端切换交接 ${st.lastBackendId}→${backendId}] ${recentText}`);
    }

    const externalSessionId = chatStore.getBackendSession(convKey, backendId);
    const summaryPrefix = !externalSessionId ? chatStore.consumeRollingSummary(convKey) : '';
    const effectiveSystem = summaryPrefix
      ? `${systemPrompt}\n\n【上段对话摘要】\n${summaryPrefix}`.trim()
      : systemPrompt;

    const result = await backend.runTurn({
      convKey,
      externalSessionId,
      model,
      systemPrompt: effectiveSystem,
      deltaPrompt,
      socketPath,
      scope,
      signal,
      onEvent,
    });

    if (result?.externalSessionId) {
      chatStore.setBackendSession(convKey, backendId, result.externalSessionId);
    } else if (!externalSessionId) {
      chatStore.ensure(convKey).lastBackendId = backendId;
    }

    if (result?.usage) {
      chatStore.recordUsage(convKey, result.usage);
      onUsage?.(convKey, backendId, result.usage);
    }

    return {
      backendId,
      model: result?.model || model,
      ...result,
    };
  }

  return {
    getBackend,
    listBackends,
    listModels,
    checkHealth,
    resolveForChat,
    switchRuntime,
    resetChatSession,
    runTurn,
  };
}
