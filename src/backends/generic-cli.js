// 通用 CLI 后端适配器：按配置模板支持任意第三方 CLI（如 claude / codex / opencode / 自定义脚本）
import { buildCombinedPrompt, normalizeUsage, runSpawnedCli } from './base.js';

export function createGenericCliBackend({ profileId, getConfig, spawnFn, rootDir = process.cwd() }) {
  function getProfile() {
    return getConfig()?.backends?.cliProfiles?.[profileId] ?? null;
  }

  async function listModels() {
    const p = getProfile();
    if (!p) return { models: [], live: false };
    const runtimeModel = getConfig()?.runtime?.activeBackend === profileId ? getConfig()?.runtime?.activeModel : '';
    const models = [...new Set([p.model, runtimeModel, ...(p.models ?? [])].filter(Boolean))];
    return { models, live: false };
  }

  async function checkHealth() {
    const p = getProfile();
    if (!p) return { ok: false, detail: `配置中未找到 cliProfile: ${profileId}` };
    return { ok: true, detail: `command=${p.command} format=${p.outputFormat}` };
  }

  async function runTurn({
    externalSessionId = '',
    model = '',
    systemPrompt = '',
    deltaPrompt = '',
    socketPath = '',
    scope = 'chat',
    signal = null,
    onEvent,
  }) {
    const p = getProfile();
    if (!p) return { ok: false, error: `未知 CLI 配置：${profileId}` };
    const chosenModel = model || p.model || '';
    const isFresh = !externalSessionId;
    const effectivePrompt = buildCombinedPrompt({
      systemPrompt,
      deltaPrompt,
      includeSystem: isFresh && Boolean(systemPrompt),
    });

    const args = [];
    let usedModelPlaceholder = false;
    let usedResumePlaceholder = false;

    for (const token of p.argsTemplate ?? ['-p', '{{prompt}}']) {
      if (token.includes('{{model}}')) usedModelPlaceholder = true;
      if (token.includes('{{sessionId}}')) usedResumePlaceholder = true;
      const expanded = token
        .replaceAll('{{prompt}}', effectivePrompt)
        .replaceAll('{{model}}', chosenModel)
        .replaceAll('{{sessionId}}', externalSessionId)
        .replaceAll('{{systemPrompt}}', systemPrompt);
      if (expanded === '' && (token === '{{model}}' || token === '{{sessionId}}')) continue;
      args.push(expanded);
    }

    if (!usedModelPlaceholder && chosenModel && p.modelFlag) {
      args.push(p.modelFlag, chosenModel);
    }
    if (!usedResumePlaceholder && externalSessionId && p.resumeFlag) {
      args.push(p.resumeFlag, externalSessionId);
    }

    const env = {
      ...process.env,
      ...(p.env ?? {}),
      ...(socketPath ? { QQ_SESSION_SOCK: socketPath, QQ_MODULE_SCOPE: scope || 'chat' } : {}),
    };

    let nextSessionId = externalSessionId;
    let text = '';
    let resultText = '';
    let usage;
    let streamErr = null;

    const run = await runSpawnedCli({
      command: p.command,
      args,
      cwd: rootDir,
      env,
      timeoutMs: p.timeoutMs || 300000,
      signal,
      spawnFn,
      onStdoutLine: (line) => {
        if (p.outputFormat !== 'jsonl') return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        onEvent?.(obj);
        const sid = obj.session_id ?? obj.sessionId ?? obj.conversation_id ?? obj.thread_id;
        if (sid) nextSessionId = String(sid);
        if (typeof obj.content === 'string') text += obj.content;
        else if (typeof obj.text === 'string') text += obj.text;
        if (typeof obj.result === 'string') resultText = obj.result;
        if (typeof obj.response === 'string') resultText = obj.response;
        const u = normalizeUsage(obj.usage ?? obj.stats);
        if (u) usage = u;
        if (obj.is_error || obj.status === 'error') {
          streamErr = String(obj.error?.message ?? obj.error ?? 'cli error');
        }
      },
    });

    if (run.spawnError) return { ok: false, error: run.spawnError, externalSessionId: nextSessionId };
    if (run.aborted) return { ok: false, aborted: true, error: '已取消', externalSessionId: nextSessionId };
    if (run.timedOut) return { ok: false, timedOut: true, error: '执行超时', externalSessionId: nextSessionId };
    if (streamErr) return { ok: false, error: streamErr, externalSessionId: nextSessionId, usage };
    if (run.exitCode && run.exitCode !== 0 && !run.stdout.trim()) {
      return { ok: false, error: run.stderr.trim() || `${p.command} exit ${run.exitCode}`, externalSessionId: nextSessionId };
    }

    const finalText = p.outputFormat === 'jsonl' ? (resultText || text) : run.stdout.trim();
    return {
      ok: true,
      externalSessionId: nextSessionId,
      model: chosenModel,
      text: finalText,
      usage,
    };
  }

  return {
    get id() { return profileId; },
    get label() { return getProfile()?.label || profileId; },
    checkHealth,
    listModels,
    runTurn,
    resetSession: async () => {},
    updateConfig: () => {},
  };
}
