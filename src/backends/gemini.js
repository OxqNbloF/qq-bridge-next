// Gemini CLI 后端适配器
import { buildCombinedPrompt, normalizeUsage, probeHelpCapabilities, runSpawnedCli } from './base.js';

export function parseGeminiCapabilities(helpText) {
  const text = String(helpText ?? '');
  const has = (flag) => new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=]|$)`).test(text);
  return {
    resume: has('--resume'),
    model: has('--model'),
    allowedMcpServerNames: has('--allowed-mcp-server-names'),
    yolo: has('--yolo'),
  };
}

export function parseGeminiStreamLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  const kind = String(obj.type ?? obj.event ?? '').toLowerCase();
  const sid = obj.session_id ?? obj.sessionId ?? obj.conversation_id ?? null;
  if (kind === 'init') return { kind: 'init', sessionId: sid ? String(sid) : null, model: obj.model ?? null };
  if (kind === 'message') {
    if (obj.role && obj.role !== 'assistant' && obj.role !== 'model') return { kind: 'noop' };
    const text = typeof obj.content === 'string' ? obj.content : (typeof obj.text === 'string' ? obj.text : '');
    return { kind: obj.delta === true ? 'text_delta' : 'text_full', text };
  }
  if (kind === 'result') {
    const isError = obj.status === 'error' || obj.is_error === true || Boolean(obj.error);
    return {
      kind: 'result',
      sessionId: sid ? String(sid) : null,
      text: typeof obj.response === 'string' ? obj.response : (typeof obj.text === 'string' ? obj.text : ''),
      usage: obj.stats ?? obj.usage ?? null,
      model: obj.model ?? null,
      isError,
      error: isError ? String(obj.error?.message ?? obj.error ?? 'gemini failed') : null,
    };
  }
  if (kind === 'error') {
    return { kind: 'error', message: String(obj.error?.message ?? obj.message ?? obj.error ?? 'gemini error') };
  }
  return { kind: 'noop' };
}

export function createGeminiBackend({ getConfig, spawnFn, detectCapsFn, rootDir = process.cwd() }) {
  const capsCache = new Map();

  async function listModels() {
    const gemCfg = getConfig()?.backends?.gemini ?? {};
    const runtimeModel = getConfig()?.runtime?.activeBackend === 'gemini' ? getConfig()?.runtime?.activeModel : '';
    const models = [...new Set([gemCfg.model, runtimeModel, ...(gemCfg.models ?? [])].filter(Boolean))];
    return { models, live: false };
  }

  async function checkHealth() {
    const gemCfg = getConfig()?.backends?.gemini ?? {};
    const cmd = gemCfg.command || 'gemini';
    const caps = probeHelpCapabilities(cmd, parseGeminiCapabilities, capsCache, detectCapsFn);
    return { ok: true, detail: `command=${cmd} caps=${JSON.stringify(caps)}` };
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
    const gemCfg = getConfig()?.backends?.gemini ?? {};
    const cmd = gemCfg.command || 'gemini';
    const caps = probeHelpCapabilities(cmd, parseGeminiCapabilities, capsCache, detectCapsFn);
    const chosenModel = model || gemCfg.model || '';
    const isFresh = !externalSessionId;

    const effectivePrompt = buildCombinedPrompt({
      systemPrompt,
      deltaPrompt,
      includeSystem: isFresh && Boolean(systemPrompt),
    });

    const args = [...(gemCfg.args ?? []), '--prompt', effectivePrompt, '--output-format', 'stream-json'];
    if (externalSessionId && caps.resume) args.push('--resume', externalSessionId);
    if (chosenModel && chosenModel !== 'default' && chosenModel !== 'auto' && caps.model) {
      args.push('--model', chosenModel);
    }
    if (caps.allowedMcpServerNames && scope !== 'admin') {
      args.push('--allowed-mcp-server-names', 'qq-broker');
    }

    const env = {
      ...process.env,
      ...(socketPath ? { QQ_SESSION_SOCK: socketPath, QQ_MODULE_SCOPE: scope || 'chat' } : {}),
    };

    let nextSessionId = externalSessionId;
    let text = '';
    let resultText = '';
    let usage;
    let activeModel = chosenModel;
    let streamErr = null;

    const run = await runSpawnedCli({
      command: cmd,
      args,
      cwd: rootDir,
      env,
      timeoutMs: gemCfg.timeoutMs || 300000,
      signal,
      spawnFn,
      onStdoutLine: (line) => {
        const parsed = parseGeminiStreamLine(line);
        if (!parsed) return;
        onEvent?.(parsed);
        if (parsed.kind === 'init') {
          if (parsed.sessionId) nextSessionId = parsed.sessionId;
          if (parsed.model) activeModel = parsed.model;
        } else if (parsed.kind === 'text_delta') {
          text += parsed.text;
        } else if (parsed.kind === 'text_full') {
          text = parsed.text;
        } else if (parsed.kind === 'result') {
          if (parsed.sessionId) nextSessionId = parsed.sessionId;
          if (parsed.text) resultText = parsed.text;
          if (parsed.usage) usage = normalizeUsage(parsed.usage);
          if (parsed.isError) streamErr = parsed.error || 'gemini error';
        } else if (parsed.kind === 'error') {
          streamErr = parsed.message;
        }
      },
    });

    if (run.spawnError) return { ok: false, error: run.spawnError, externalSessionId: nextSessionId };
    if (run.aborted) return { ok: false, aborted: true, error: '已取消', externalSessionId: nextSessionId };
    if (run.timedOut) return { ok: false, timedOut: true, error: '执行超时', externalSessionId: nextSessionId };
    if (streamErr) return { ok: false, error: streamErr, externalSessionId: nextSessionId, usage };
    if (run.exitCode && run.exitCode !== 0 && !text && !resultText) {
      return { ok: false, error: run.stderr.trim() || `gemini exit ${run.exitCode}`, externalSessionId: nextSessionId };
    }

    return {
      ok: true,
      externalSessionId: nextSessionId,
      model: activeModel,
      text: resultText || text,
      usage,
    };
  }

  return {
    id: 'gemini',
    label: 'Gemini CLI',
    checkHealth,
    listModels,
    runTurn,
    resetSession: async () => {},
    updateConfig: () => {},
  };
}
