// Gemini CLI 后端适配器：实现与 NodeApiClient / AgyApiClient 兼容的会话/事件流接口
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { extractPresetPrefix } from '../preset-prompt.js';
import { decodeSelfKeyFromSessionId } from './agy-client.js';
import { atomicWriteJson, readJsonSafe } from '../store/fs-atomic.js';

function okResult(value) {
  return { result: { ok: true, value } };
}
function errResult(code, message) {
  return { result: { ok: false, error: { code, message } } };
}

/** 解析 gemini --help 支持的参数 */
export function parseGeminiHelpCapabilities(helpText) {
  const text = String(helpText ?? '');
  const hasFlag = (flag) => new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=]|$)`).test(text);
  return {
    resume: hasFlag('--resume'),
    model: hasFlag('--model'),
    allowedMcpServerNames: hasFlag('--allowed-mcp-server-names'),
    yolo: hasFlag('--yolo'),
  };
}

/** 解析 Gemini CLI stream-json 单行输出 */
export function parseGeminiStreamLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const kind = String(obj.type ?? obj.event ?? '').toLowerCase();
  const sessionId = obj.session_id ?? obj.sessionId ?? obj.conversation_id ?? null;

  if (kind === 'init') {
    return {
      kind: 'init',
      sessionId: sessionId ? String(sessionId) : null,
      model: obj.model ?? null,
    };
  }
  if (kind === 'message') {
    if (obj.role && obj.role !== 'assistant' && obj.role !== 'model') return { kind: 'noop' };
    const text = typeof obj.content === 'string' ? obj.content : (typeof obj.text === 'string' ? obj.text : '');
    if (!text) return { kind: 'noop' };
    return obj.delta === true ? { kind: 'text_delta', text } : { kind: 'text_full', text };
  }
  if (kind === 'tool_use' || kind === 'tool_call') {
    return {
      kind: 'tool_call',
      callId: String(obj.tool_id ?? obj.call_id ?? obj.id ?? randomUUID()),
      name: String(obj.tool_name ?? obj.name ?? ''),
      arguments: obj.parameters ?? obj.arguments ?? obj.input ?? {},
    };
  }
  if (kind === 'tool_result') {
    return {
      kind: 'tool_result',
      callId: String(obj.tool_id ?? obj.call_id ?? obj.id ?? ''),
      isError: obj.status === 'error' || obj.is_error === true || Boolean(obj.error),
      text: typeof obj.output === 'string' ? obj.output : String(obj.error?.message ?? obj.error ?? ''),
    };
  }
  if (kind === 'result') {
    const stats = obj.stats ?? obj.usage ?? null;
    const isError = obj.status === 'error' || obj.is_error === true || Boolean(obj.error);
    return {
      kind: 'result',
      sessionId: sessionId ? String(sessionId) : null,
      text: typeof obj.response === 'string' ? obj.response : (typeof obj.text === 'string' ? obj.text : ''),
      usage: stats,
      model: obj.model ?? null,
      isError,
      error: isError ? String(obj.error?.message ?? obj.error ?? 'gemini execution failed') : null,
    };
  }
  if (kind === 'error') {
    return {
      kind: 'error',
      message: String(obj.error?.message ?? obj.message ?? obj.error ?? 'gemini stream error'),
    };
  }
  return { kind: 'noop' };
}

function normalizeGeminiUsage(stats, model) {
  if (!stats || typeof stats !== 'object') return undefined;
  const inputTokens = Number(stats.input_tokens ?? stats.prompt_tokens ?? stats.total_input_tokens ?? 0) || 0;
  const outputTokens = Number(stats.output_tokens ?? stats.completion_tokens ?? stats.total_output_tokens ?? 0) || 0;
  const cachedTokens = Number(stats.cached ?? stats.cached_tokens ?? stats.cache_read_input_tokens ?? 0) || 0;
  if (!inputTokens && !outputTokens && !cachedTokens) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedTokens,
    ...(model ? { model } : {}),
  };
}

function materializePromptContent(content, cwd, turnNumber) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  const textParts = [];
  const savedImages = [];
  let imageIndex = 0;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
    } else if (part.type === 'image' && typeof part.data === 'string' && cwd) {
      imageIndex += 1;
      const ext = String(part.mediaType ?? part.mimeType ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const rawName = String(part.name ?? `img-${imageIndex}.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');
      const mediaDir = path.join(cwd, '.qq-media');
      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        const filePath = path.join(mediaDir, `t${turnNumber}-${imageIndex}-${rawName}`);
        fs.writeFileSync(filePath, Buffer.from(part.data, 'base64'));
        savedImages.push(filePath);
      } catch {}
    }
  }
  let prompt = textParts.join('\n').trim();
  if (savedImages.length > 0) {
    prompt += `\n\n[附带图片本地路径]\n${savedImages.map((p) => `- ${p}`).join('\n')}`;
  }
  return prompt;
}

export class GeminiApiClient {
  constructor(options = {}) {
    this.backendType = 'gemini';
    this.backendLabel = 'Gemini CLI';
    this.supportsPortDiscovery = false;

    this.command = String(options.command || 'gemini').trim() || 'gemini';
    this.extraArgs = Array.isArray(options.args) ? options.args.map(String) : [];
    this.defaultModel = String(options.model || '').trim();
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 5 * 60 * 1000;
    this.injectPresetPrompt = options.injectPresetPrompt !== false;
    this.brokerEnabled = options.brokerEnabled === true;
    this.compactPrompt = options.compactPrompt === true;
    this.sessionSocketProvider = typeof options.sessionSocketProvider === 'function' ? options.sessionSocketProvider : null;
    this.compactSystemPromptProvider = typeof options.compactSystemPromptProvider === 'function' ? options.compactSystemPromptProvider : null;
    this.rootDir = options.rootDir || process.cwd();
    this.stateDir = options.stateDir || '';
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.appendActivity = typeof options.appendActivity === 'function' ? options.appendActivity : () => {};
    this._spawn = options.spawn || spawn;
    this._checkAvailable = options.checkAvailable || null;
    this._detectCapabilities = typeof options.detectCapabilities === 'function' ? options.detectCapabilities : null;

    this._sessionsFile = this.stateDir ? path.join(this.stateDir, 'gemini-sessions.json') : '';
    this._sessions = new Map();
    this._workspaces = new Map();
    this._desiredFollows = new Set();
    this._listeners = new Set();
    this._modeOverride = '';
    this._availabilityCache = { ok: false, checkedAt: 0 };
    this._capabilities = null;

    this._loadPersistedSessions();
  }

  resolveBase() { return `gemini://${this.command}`; }
  rebind() { return false; }
  hasAuth() { return true; }
  invalidateAuth() {}

  _getCapabilities() {
    if (this._capabilities) return this._capabilities;
    let caps;
    let shouldCache = true;
    if (this._detectCapabilities) {
      caps = {
        resume: true,
        model: true,
        allowedMcpServerNames: false,
        yolo: true,
        ...(this._detectCapabilities(this.command) ?? {}),
      };
    } else {
      try {
        const res = spawnSync(this.command, ['--help'], { encoding: 'utf8', timeout: 5000 });
        if (res.error) shouldCache = false;
        caps = parseGeminiHelpCapabilities(`${res.stdout || ''}\n${res.stderr || ''}`);
      } catch {
        shouldCache = false;
        caps = parseGeminiHelpCapabilities('');
      }
    }
    if (shouldCache) this._capabilities = caps;
    return caps;
  }

  updateConfig(nextCfg = {}) {
    if (!nextCfg || typeof nextCfg !== 'object') return;
    if (nextCfg.model !== undefined) this.defaultModel = String(nextCfg.model || '').trim();
    if (nextCfg.timeoutMs !== undefined) {
      const n = Number(nextCfg.timeoutMs);
      if (Number.isFinite(n) && n > 0) this.timeoutMs = n;
    }
    if (nextCfg.injectPresetPrompt !== undefined) {
      this.injectPresetPrompt = nextCfg.injectPresetPrompt !== false;
      for (const s of this._sessions.values()) s.systemPrompt = this._loadPresetPrompt(s.agentPreset);
    }
  }

  updateBrokerConfig(nextBroker = {}) {
    if (!nextBroker || typeof nextBroker !== 'object') return;
    if (nextBroker.enabled !== undefined) this.brokerEnabled = nextBroker.enabled === true;
    if (nextBroker.compactPrompt !== undefined) this.compactPrompt = nextBroker.compactPrompt === true;
  }

  onPermissionsChanged() {
    for (const s of this._sessions.values()) {
      s.geminiSessionId = '';
      s.permissionRefreshNotice = true;
    }
    this._persistSessions();
  }

  resetConversationForCompaction(sessionId, summary = '') {
    const s = this._sessions.get(String(sessionId ?? ''));
    if (!s) return false;
    s.geminiSessionId = '';
    if (summary) s.rollingSummary = String(summary);
    this._persistSessions();
    return true;
  }

  _loadPersistedSessions() {
    if (!this._sessionsFile) return;
    const saved = readJsonSafe(this._sessionsFile, null);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [sessionId, meta] of Object.entries(saved)) {
      if (!meta || typeof meta !== 'object') continue;
      this._sessions.set(sessionId, {
        sessionId,
        cwd: String(meta.cwd || this.rootDir),
        agentPreset: meta.agentPreset ? String(meta.agentPreset) : '',
        restricted: meta.restricted !== false && Boolean(meta.agentPreset && meta.agentPreset !== 'default'),
        selfKey: String(meta.selfKey || decodeSelfKeyFromSessionId(sessionId)),
        systemPrompt: this._loadPresetPrompt(meta.agentPreset),
        model: String(meta.model || this.defaultModel || ''),
        geminiSessionId: meta.geminiSessionId ? String(meta.geminiSessionId) : '',
        rollingSummary: meta.rollingSummary ? String(meta.rollingSummary) : '',
        permissionRefreshNotice: meta.permissionRefreshNotice === true,
        turnCounter: Number(meta.turnCounter) || 0,
        eventSeq: Number(meta.eventSeq) || 0,
        queue: [],
        running: false,
        activeChild: null,
        activeTurn: null,
        cancelled: false,
      });
    }
  }

  _persistSessions() {
    if (!this._sessionsFile) return;
    const out = {};
    for (const [sessionId, s] of this._sessions) {
      out[sessionId] = {
        cwd: s.cwd,
        agentPreset: s.agentPreset,
        restricted: s.restricted,
        selfKey: s.selfKey,
        model: s.model,
        geminiSessionId: s.geminiSessionId,
        rollingSummary: s.rollingSummary || '',
        permissionRefreshNotice: Boolean(s.permissionRefreshNotice),
        turnCounter: s.turnCounter,
        eventSeq: s.eventSeq,
      };
    }
    try { atomicWriteJson(this._sessionsFile, out); } catch {}
  }

  _discoverPresets() {
    const presetsDir = path.join(this.rootDir, 'dsh', 'agent-presets');
    const presets = [];
    try {
      for (const entry of fs.readdirSync(presetsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(presetsDir, entry.name, 'agent.cordis.yml'))) {
          presets.push({ id: entry.name, trust: 'restricted', isDefault: false });
        }
      }
    } catch {}
    if (!presets.some((p) => p.id === 'qq-chat')) presets.push({ id: 'qq-chat', trust: 'restricted', isDefault: false });
    if (!presets.some((p) => p.id === 'qq-chat-v2')) presets.push({ id: 'qq-chat-v2', trust: 'restricted', isDefault: false });
    presets.push({ id: 'default', trust: 'system', isDefault: true });
    return presets;
  }

  _loadPresetPrompt(presetName) {
    if (!presetName || presetName === 'default' || !this.injectPresetPrompt) return '';
    const safeName = String(presetName).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safeName) return '';
    try {
      return extractPresetPrefix(fs.readFileSync(path.join(this.rootDir, 'dsh', 'agent-presets', safeName, 'agent.cordis.yml'), 'utf8')) || '';
    } catch {
      return '';
    }
  }

  async _isCliAvailable() {
    const now = Date.now();
    if (this._availabilityCache.ok && now - this._availabilityCache.checkedAt < 15_000) return true;
    let ok = false;
    if (this._checkAvailable) {
      ok = Boolean(await this._checkAvailable(this.command));
    } else {
      try {
        const res = spawnSync(this.command, ['--version'], { stdio: 'ignore', timeout: 5000 });
        ok = !res.error && res.status === 0;
      } catch {
        ok = false;
      }
    }
    this._availabilityCache = { ok, checkedAt: now };
    if (ok) this._getCapabilities();
    return ok;
  }

  _emitSessionEvent(sessionId, event) {
    if (!this._desiredFollows.has(sessionId)) return;
    const session = this._sessions.get(sessionId);
    const seq = session ? (session.eventSeq += 1) : undefined;
    const envelope = {
      rpcId: `gemini-${sessionId}-${seq ?? Date.now()}`,
      payload: { type: 'session/event', sessionId, event: { ...event, ...(seq !== undefined ? { seq } : {}) } },
    };
    for (const push of this._listeners) push(envelope);
  }

  settings = {
    describe: async () => {
      const ok = await this._isCliAvailable();
      if (!ok) throw new Error(`Gemini CLI (${this.command}) 不可用，请确认已安装并在 PATH 中`);
      const namespaces = [{ ns: 'agent-presets', values: { default: 'default' } }];
      if (this._modeOverride) namespaces.push({ ns: 'qq-mode', values: { mode: this._modeOverride } });
      return okResult({ namespaces });
    },
    update: async ({ ns, patch } = {}) => {
      if (ns === 'qq-mode' && patch && typeof patch.mode === 'string') this._modeOverride = patch.mode;
      return okResult({ ok: true });
    },
  };

  agentPresets = { list: async () => okResult({ presets: this._discoverPresets() }) };

  workspace = {
    create: async ({ path: dir } = {}) => {
      const target = String(dir || this.rootDir);
      fs.mkdirSync(target, { recursive: true });
      const created = !this._workspaces.has(target);
      if (created) this._workspaces.set(target, { path: target, title: '' });
      return okResult({ created, workspace: { workspaceId: target, path: target } });
    },
    rename: async ({ workspaceId, title } = {}) => {
      const ws = this._workspaces.get(String(workspaceId));
      if (ws) ws.title = String(title ?? '');
      return okResult({ ok: true });
    },
    archiveSession: async ({ sessionId } = {}) => {
      const sid = String(sessionId ?? '');
      if (sid) {
        await this.stopSessionWork(sid).catch(() => {});
        this._sessions.delete(sid);
        this._desiredFollows.delete(sid);
        this._persistSessions();
      }
      return okResult({ ok: true });
    },
  };

  sessions = {
    create: async ({ workspaceId, agentPreset, sessionId } = {}) => {
      const sid = String(sessionId || `gemini-${randomUUID()}`);
      const cwd = String(workspaceId || this.rootDir);
      fs.mkdirSync(cwd, { recursive: true });
      const preset = agentPreset ? String(agentPreset) : '';
      const restricted = Boolean(preset && preset !== 'default');
      const session = {
        sessionId: sid,
        cwd,
        agentPreset: preset,
        restricted,
        selfKey: decodeSelfKeyFromSessionId(sid),
        systemPrompt: this._loadPresetPrompt(preset),
        model: this.defaultModel || '',
        geminiSessionId: '',
        rollingSummary: '',
        permissionRefreshNotice: false,
        turnCounter: 0,
        eventSeq: 0,
        queue: [],
        running: false,
        activeChild: null,
        activeTurn: null,
        cancelled: false,
      };
      this._sessions.set(sid, session);
      this._persistSessions();
      return okResult({ sessionId: sid });
    },
    list: async () => okResult({
      sessions: [...this._sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        workspaceId: s.cwd,
        agentPreset: s.agentPreset || undefined,
      })),
    }),
    selectModel: async ({ sessionId, provider, model, reasoningEffort } = {}) => {
      const sid = String(sessionId ?? '');
      const session = this._sessions.get(sid);
      if (!session) return errResult('session/not-found', `session not found: ${sid}`);
      const chosen = String(model || this.defaultModel || 'default');
      session.model = chosen;
      this._persistSessions();
      return okResult({ selected: { provider: provider || 'gemini', model: chosen, reasoningEffort: reasoningEffort || null } });
    },
    prompt: async ({ sessionId, content } = {}) => {
      const sid = String(sessionId ?? '');
      const session = this._sessions.get(sid);
      if (!session) return errResult('session/not-found', `session not found: ${sid}`);
      session.queue.push({ content });
      void this._drainSessionQueue(session);
      return okResult({ accepted: true, sessionId: sid });
    },
    cancel: async ({ sessionId } = {}) => {
      const sid = String(sessionId ?? '');
      const session = this._sessions.get(sid);
      if (!session) return errResult('session/not-found', `session not found: ${sid}`);
      this._killActiveChild(session);
      return okResult({ ok: true });
    },
  };

  async stopSessionWork(sessionId) {
    const sid = String(sessionId ?? '');
    if (!sid) throw new Error('sessionId is required');
    const session = this._sessions.get(sid);
    if (!session) return { removed: 0 };
    const removed = session.queue.length;
    session.queue.length = 0;
    this._killActiveChild(session);
    return { removed };
  }

  _killActiveChild(session) {
    if (!session?.activeChild) return;
    session.cancelled = true;
    const child = session.activeChild;
    try { child.kill('SIGTERM'); } catch {}
    const forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    forceTimer.unref?.();
  }

  async _drainSessionQueue(session) {
    if (session.running) return;
    session.running = true;
    try {
      while (session.queue.length > 0) {
        const item = session.queue.shift();
        await this._executeTurn(session, item.content);
      }
    } finally {
      session.running = false;
    }
  }

  _buildCliArgs(session, promptText, caps = this._getCapabilities()) {
    const sysInstruction = this.compactPrompt && session.restricted && this.compactSystemPromptProvider
      ? this.compactSystemPromptProvider(session.selfKey)
      : session.systemPrompt;
    const useInlineSystem = Boolean(sysInstruction && !session.geminiSessionId && (this.injectPresetPrompt || this.compactPrompt));
    const effectivePrompt = useInlineSystem
      ? `<system>\n${sysInstruction}\n</system>\n\n---\n\n${promptText}`
      : promptText;

    const args = [...this.extraArgs, '--prompt', effectivePrompt, '--output-format', 'stream-json'];
    if (session.geminiSessionId && caps.resume) {
      args.push('--resume', session.geminiSessionId);
    }
    const model = session.model || this.defaultModel;
    if (model && model !== 'default' && model !== 'auto' && caps.model) {
      args.push('--model', model);
    }
    if (this.brokerEnabled && session.restricted && caps.allowedMcpServerNames) {
      args.push('--allowed-mcp-server-names', 'qq-broker');
    }
    return args;
  }

  async _executeTurn(session, content) {
    session.turnCounter += 1;
    const turn = session.turnCounter;
    session.activeTurn = turn;
    session.cancelled = false;

    let promptText = materializePromptContent(content, session.cwd, turn);
    if (session.rollingSummary && !session.geminiSessionId) {
      promptText = `【上段对话摘要】${session.rollingSummary}\n\n${promptText}`;
      session.rollingSummary = '';
      this._persistSessions();
    }
    if (session.permissionRefreshNotice) {
      session.permissionRefreshNotice = false;
      this._persistSessions();
    }

    const caps = this._getCapabilities();
    const args = this._buildCliArgs(session, promptText, caps);
    let sockEnv = {};
    if (this.brokerEnabled && this.sessionSocketProvider && session.selfKey) {
      const sock = await this.sessionSocketProvider(session.selfKey);
      if (sock?.socketPath) {
        sockEnv = { QQ_SESSION_SOCK: sock.socketPath, QQ_MODULE_SCOPE: sock.scope || 'chat' };
      }
    }
    const env = {
      ...process.env,
      ...(session.selfKey && !this.brokerEnabled ? { QQ_BRIDGE_SELF_KEY: session.selfKey } : {}),
      ...sockEnv,
    };

    this._emitSessionEvent(session.sessionId, { type: 'turn/start', data: { turn } });

    let accumulatedText = '';
    let fullTextFromResult = '';
    let stderrBuf = '';
    let usage;
    let activeModel = session.model || this.defaultModel || 'gemini';
    let streamError = null;
    let timedOut = false;
    let exitCode = null;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (session.activeChild === child) session.activeChild = null;
        session.activeTurn = null;
        resolve();
      };

      let child;
      try {
        child = this._spawn(this.command, args, { cwd: session.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        streamError = String(error?.message ?? error);
        finish();
        return;
      }

      session.activeChild = child;
      const killTimer = setTimeout(() => {
        timedOut = true;
        streamError = `gemini CLI 执行超时（${Math.round(this.timeoutMs / 1000)}s）`;
        this._killActiveChild(session);
      }, this.timeoutMs);
      killTimer.unref?.();

      let lineBuf = '';
      const handleLine = (rawLine) => {
        const parsed = parseGeminiStreamLine(rawLine);
        if (!parsed || parsed.kind === 'noop') return;
        if (parsed.kind === 'init') {
          if (parsed.sessionId) {
            session.geminiSessionId = parsed.sessionId;
            this._persistSessions();
          }
          if (parsed.model) {
            activeModel = parsed.model;
            this._emitSessionEvent(session.sessionId, { type: 'model/selection', data: { provider: 'gemini', model: parsed.model } });
          }
          return;
        }
        if (parsed.kind === 'text_delta') {
          accumulatedText += parsed.text;
          this._emitSessionEvent(session.sessionId, { type: 'assistant/chunk', data: { turn, text: parsed.text } });
          return;
        }
        if (parsed.kind === 'text_full') {
          accumulatedText = parsed.text;
          return;
        }
        if (parsed.kind === 'tool_call') {
          this._emitSessionEvent(session.sessionId, { type: 'tool/call', data: { turn, callId: parsed.callId, name: parsed.name, arguments: parsed.arguments } });
          return;
        }
        if (parsed.kind === 'tool_result') {
          this._emitSessionEvent(session.sessionId, {
            type: 'tool/result',
            data: { turn, message: { source: { callId: parsed.callId }, isError: parsed.isError, content: [{ type: 'text', text: parsed.text, isError: parsed.isError }] } },
          });
          return;
        }
        if (parsed.kind === 'result') {
          if (parsed.sessionId) { session.geminiSessionId = parsed.sessionId; this._persistSessions(); }
          if (parsed.model) activeModel = parsed.model;
          if (parsed.text) fullTextFromResult = parsed.text;
          if (parsed.usage) usage = normalizeGeminiUsage(parsed.usage, activeModel);
          if (parsed.isError && parsed.error) streamError = parsed.error;
          return;
        }
        if (parsed.kind === 'error') streamError = parsed.message;
      };

      child.stdout?.on('data', (chunk) => {
        lineBuf += chunk.toString('utf8');
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      });
      child.on('error', (error) => { streamError = String(error?.message ?? error); finish(); });
      child.on('close', (code) => {
        exitCode = code;
        if (lineBuf.trim()) handleLine(lineBuf);
        if (!session.cancelled && !timedOut && code !== 0 && !streamError) {
          const tail = stderrBuf.trim().slice(-600);
          streamError = tail ? `gemini 退出码=${code}，stderr=${tail}` : `gemini 退出码=${code}`;
        }
        finish();
      });
    });

    const finalText = accumulatedText || fullTextFromResult;
    if (finalText || usage) {
      this._emitSessionEvent(session.sessionId, {
        type: 'assistant/message',
        data: {
          turn,
          provider: 'gemini',
          ...(usage ? { usage } : {}),
          message: { role: 'assistant', content: finalText ? [{ type: 'text', text: finalText }] : [] },
        },
      });
    }

    const reason = timedOut
      ? { kind: 'error', error: { message: streamError || 'gemini CLI 执行超时', code: 'timeout' } }
      : session.cancelled
        ? { kind: 'aborted' }
        : streamError
          ? { kind: 'error', error: { message: streamError, code: exitCode !== null && exitCode !== 0 ? `exit-${exitCode}` : 'gemini-error' } }
          : { kind: 'completed' };

    this._emitSessionEvent(session.sessionId, { type: 'turn/end', data: { turn, reason } });
    this._persistSessions();
  }

  async callUnary(method) {
    const endpoint = String(method ?? '').replace(/\./g, '/');
    if (endpoint === 'session/modelCatalog' || endpoint === 'session/models') {
      const modelId = this.defaultModel || 'default';
      return {
        rpcId: `gemini-${randomUUID()}`,
        ...okResult({ groups: [{ id: 'gemini', name: 'Gemini CLI', models: [{ id: modelId, name: modelId }] }] }),
      };
    }
    return { rpcId: `gemini-${randomUUID()}`, ...errResult('method/not-supported', `gemini backend does not support ${endpoint}`) };
  }

  async respond() { return okResult({ ok: true }); }

  events = {
    mux: (_payload, signal, onOpen) => this._openEventStream(signal, onOpen),
    host: (_payload, signal, onOpen) => this._openEventStream(signal, onOpen),
    follow: (sessionId) => { if (sessionId) this._desiredFollows.add(String(sessionId)); },
    forget: (sessionId) => { if (sessionId) this._desiredFollows.delete(String(sessionId)); },
  };

  _openEventStream(signal, onOpen) {
    const gen = this._eventGenerator(signal, onOpen);
    return {
      [Symbol.asyncIterator]: () => gen,
      follow: (sessionId) => this.events.follow(sessionId),
      forget: (sessionId) => this.events.forget(sessionId),
    };
  }

  async *_eventGenerator(signal, onOpen) {
    const inbox = [];
    let wake;
    let ended = false;
    const push = (env) => { if (!ended) { inbox.push(env); wake?.(); wake = undefined; } };
    const stop = () => { ended = true; wake?.(); wake = undefined; };
    this._listeners.add(push);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      if (!ended) onOpen?.();
      while (!ended) {
        while (inbox.length > 0) yield inbox.shift();
        if (ended) break;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      this._listeners.delete(push);
      signal?.removeEventListener('abort', stop);
    }
  }
}
