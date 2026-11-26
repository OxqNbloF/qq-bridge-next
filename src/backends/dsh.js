// DeepSeek Harness (DSH) 后端适配器：封装 NodeApiClient 并实现统一会话/模型/热更新契约
import { NodeApiClient, createTurnCollector, blocksToText } from './dsh-protocol.js';
import { normalizeUsage } from './base.js';

export function createDshBackend({ getConfig, clientFactory, log = () => {} }) {
  let client = null;
  let lastSig = '';
  const cachedModels = new Set();

  function getClient() {
    const dshCfg = getConfig()?.backends?.dsh ?? {};
    const sig = JSON.stringify({
      baseUrl: dshCfg.baseUrl,
      authToken: dshCfg.authToken,
      allowRemote: dshCfg.allowRemote,
    });
    if (!client || sig !== lastSig) {
      client = clientFactory
        ? clientFactory(dshCfg)
        : new NodeApiClient(dshCfg.baseUrl || 'http://127.0.0.1:3080', undefined, {
          token: dshCfg.authToken || '',
          tokenExplicit: Boolean(dshCfg.authToken),
          allowRemote: dshCfg.allowRemote === true,
        });
      lastSig = sig;
    }
    return client;
  }

  async function checkHealth() {
    try {
      const api = getClient();
      const base = api.resolveBase?.() ?? getConfig()?.backends?.dsh?.baseUrl ?? '';
      if (typeof api.system?.health === 'function') {
        const res = await api.system.health();
        return { ok: Boolean(res?.result?.ok ?? true), detail: base };
      }
      return { ok: true, detail: base };
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) };
    }
  }

  async function listModels() {
    const dshCfg = getConfig()?.backends?.dsh ?? {};
    const defaults = [dshCfg.model, 'deepseek-flash', 'deepseek-pro', ...cachedModels].filter(Boolean);
    const models = [...new Set(defaults)];
    let live = false;
    try {
      const api = getClient();
      if (typeof api.sessions?.models === 'function') {
        const res = await api.sessions.models({});
        const groups = res?.result?.value?.groups ?? [];
        for (const g of groups) {
          for (const m of g?.models ?? []) {
            const id = m?.id || m?.model;
            if (id) {
              cachedModels.add(String(id));
              if (!models.includes(String(id))) models.push(String(id));
            }
          }
        }
        if (groups.length > 0) live = true;
      } else if (typeof api.models?.list === 'function') {
        const res = await api.models.list();
        const items = res?.result?.value?.models ?? res?.result?.value?.items ?? [];
        for (const item of items) {
          const id = typeof item === 'string' ? item : (item?.id || item?.model);
          if (id) {
            cachedModels.add(String(id));
            if (!models.includes(String(id))) models.push(String(id));
          }
        }
        if (items.length > 0) live = true;
      }
    } catch {}
    return { models, live };
  }

  async function runTurn({
    convKey,
    externalSessionId = '',
    model = '',
    systemPrompt = '',
    deltaPrompt = '',
    signal = null,
    onEvent,
  }) {
    const cfg = getConfig();
    const dshCfg = cfg?.backends?.dsh ?? {};
    const api = getClient();
    let sid = externalSessionId;

    if (!sid) {
      const wsRes = await api.workspace.create({ path: process.cwd(), title: `QQ ${convKey}` });
      const wsId = wsRes?.result?.value?.workspace?.workspaceId || process.cwd();
      const createRes = await api.sessions.create({
        workspaceId: wsId,
        ...(dshCfg.agentPreset ? { agentPreset: dshCfg.agentPreset } : {}),
      });
      if (!createRes?.result?.ok) {
        throw new Error(createRes?.result?.error?.message || 'DSH 创建会话失败');
      }
      sid = createRes.result.value.sessionId;
    }

    const targetModel = model || dshCfg.model || 'deepseek-flash';
    try {
      await api.sessions.selectModel({
        sessionId: sid,
        provider: dshCfg.provider || 'deepseek-official',
        model: targetModel,
        ...(dshCfg.reasoningEffort ? { reasoningEffort: dshCfg.reasoningEffort } : {}),
      });
    } catch (error) {
      log(`[dsh] selectModel 警告 (${convKey}): ${error?.message ?? error}`);
    }

    const contentPrompt = !externalSessionId && systemPrompt
      ? `<system>\n${systemPrompt}\n</system>\n\n---\n\n${deltaPrompt}`
      : deltaPrompt;

    const turnAc = new AbortController();
    const forwardAbort = () => turnAc.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    const streamRes = typeof api.events?.mux === 'function'
      ? api.events.mux(undefined, turnAc.signal)
      : await api.sessions.events?.({ sessionId: sid, signal: turnAc.signal });
    api.events?.follow?.(sid);

    let text = '';
    let usage;
    try {
      const promptRes = await api.sessions.prompt({
        sessionId: sid,
        content: [{ type: 'text', text: contentPrompt }],
      });
      if (promptRes?.result?.ok === false) {
        throw new Error(promptRes.result.error?.message || 'DSH 发送 prompt 失败');
      }

      const collector = createTurnCollector ? createTurnCollector() : null;
      if (streamRes && typeof streamRes[Symbol.asyncIterator] === 'function') {
        for await (const ev of streamRes) {
          if (ev?.sessionId && ev.sessionId !== sid) continue;
          onEvent?.(ev);
          if (collector?.feed?.(ev)) break;
          if (ev?.type === 'assistant/message') {
            if (ev.data?.text) text = String(ev.data.text);
            else if (ev.data?.content) text = blocksToText(ev.data.content);
            if (ev.data?.usage) usage = normalizeUsage(ev.data.usage);
          }
          if (ev?.type === 'turn/end') {
            if (ev.data?.usage) usage = normalizeUsage(ev.data.usage);
            break;
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      turnAc.abort();
    }

    return {
      ok: true,
      externalSessionId: sid,
      model: targetModel,
      text,
      usage,
    };
  }

  async function resetSession(externalSessionId) {
    if (!externalSessionId) return;
    try {
      await getClient().workspace?.archiveSession?.({ sessionId: externalSessionId });
    } catch {}
  }

  return {
    id: 'dsh',
    label: 'DeepSeek Harness (DSH)',
    checkHealth,
    listModels,
    runTurn,
    resetSession,
    updateConfig: () => { lastSig = ''; },
  };
}
