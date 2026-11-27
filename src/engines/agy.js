// Antigravity CLI (agy) 执行引擎适配
import { mergeSystemAndDelta, normalizeUsage, probeHelpCapabilities, runSpawnedEngine } from './base.js';

export function parseAgyCapabilities(helpText) {
  const text = String(helpText ?? '');
  const has = (flag) => new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=]|$)`).test(text);
  return {
    systemPrompt: has('--system-prompt'),
    settings: has('--settings'),
    allowedTools: has('--allowedTools'),
    disallowedTools: has('--disallowedTools'),
    sandbox: has('--sandbox'),
  };
}

export function parseAgyStreamLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  const kind = String(obj.type ?? obj.event ?? '').toLowerCase();
  const convId = obj.conversation_id ?? obj.conversationId ?? obj.session_id ?? null;
  if (kind === 'init' || kind === 'session') return { kind: 'init', sessionId: convId ? String(convId) : null, model: obj.model ?? null };
  if (kind === 'message' || kind === 'assistant') {
    if (obj.role && obj.role !== 'assistant' && obj.role !== 'model') return { kind: 'noop' };
    const text = typeof obj.content === 'string' ? obj.content : (typeof obj.text === 'string' ? obj.text : '');
    return { kind: obj.delta === true ? 'text_delta' : 'text_full', text };
  }
  if (kind === 'result') {
    const isError = obj.is_error === true || obj.status === 'error' || Boolean(obj.error);
    return {
      kind: 'result',
      sessionId: convId ? String(convId) : null,
      text: typeof obj.result === 'string' ? obj.result : (typeof obj.response === 'string' ? obj.response : ''),
      usage: obj.usage ?? obj.stats ?? null,
      model: obj.model ?? null,
      isError,
      error: isError ? String(obj.error?.message ?? obj.error ?? 'agy failed') : null,
    };
  }
  if (kind === 'error') return { kind: 'error', message: String(obj.error?.message ?? obj.message ?? obj.error ?? 'agy error') };
  return { kind: 'noop' };
}

export function createAgyEngine({ getConfig, spawnFn, detectCapsFn, rootDir = process.cwd() }) {
  const capsCache = new Map();

  async function listModels() {
    const agyCfg = getConfig()?.engines?.agy ?? {};
    const runtimeModel = getConfig()?.engine?.active === 'agy' ? getConfig()?.engine?.model : '';
    return { models: [...new Set([agyCfg.model, runtimeModel, ...(agyCfg.models ?? [])].filter(Boolean))], live: false };
  }

  async function checkHealth() {
    const agyCfg = getConfig()?.engines?.agy ?? {};
    const cmd = agyCfg.command || 'agy';
    const caps = probeHelpCapabilities(cmd, parseAgyCapabilities, capsCache, detectCapsFn);
    return { ok: true, detail: `command=${cmd} caps=${JSON.stringify(caps)}` };
  }

  async function executeTurn({
    externalSessionId = '',
    model = '',
    systemPrompt = '',
    deltaPrompt = '',
    socketPath = '',
    scope = 'standard',
    signal = null,
    onEvent,
  }) {
    const agyCfg = getConfig()?.engines?.agy ?? {};
    const cmd = agyCfg.command || 'agy';
    const caps = probeHelpCapabilities(cmd, parseAgyCapabilities, capsCache, detectCapsFn);
    const chosenModel = model || agyCfg.model || '';
    const isFresh = !externalSessionId;
    const useSystemFlag = isFresh && Boolean(systemPrompt) && caps.systemPrompt;
    const effectivePrompt = mergeSystemAndDelta({
      systemPrompt,
      deltaPrompt,
      includeSystem: isFresh && Boolean(systemPrompt) && !useSystemFlag,
    });

    const args = [...(agyCfg.args ?? []), '-p', effectivePrompt, '--output-format', 'stream-json'];
    if (externalSessionId) args.push('--conversation', externalSessionId);
    if (chosenModel && chosenModel !== 'default' && chosenModel !== 'auto') args.push('--model', chosenModel);
    if (useSystemFlag) args.push('--system-prompt', systemPrompt);

    if (caps.settings) {
      const allow = [...new Set([...(agyCfg.permissions?.allow ?? []), 'mcp(relay-hub/*)'])];
      const deny = [...(agyCfg.permissions?.deny ?? [])];
      args.push('--settings', JSON.stringify({ permissions: { allow, deny } }));
    }

    const env = {
      ...process.env,
      ...(socketPath ? { RELAY_ROOM_SOCK: socketPath, RELAY_SCOPE: scope || 'standard' } : {}),
    };

    let nextSessionId = externalSessionId;
    let text = '';
    let resultText = '';
    let usage;
    let activeModel = chosenModel;
    let streamErr = null;

    const run = await runSpawnedEngine({
      command: cmd,
      args,
      cwd: rootDir,
      env,
      timeoutMs: agyCfg.timeoutMs || 300000,
      signal,
      spawnFn,
      onStdoutLine: (line) => {
        const parsed = parseAgyStreamLine(line);
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
          if (parsed.isError) streamErr = parsed.error || 'agy error';
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
      return { ok: false, error: run.stderr.trim() || `agy exit ${run.exitCode}`, externalSessionId: nextSessionId };
    }

    return { ok: true, externalSessionId: nextSessionId, model: activeModel, text: resultText || text, usage };
  }

  return { id: 'agy', label: 'Antigravity CLI (agy)', checkHealth, listModels, executeTurn, resetSession: async () => {}, updateConfig: () => {} };
}
