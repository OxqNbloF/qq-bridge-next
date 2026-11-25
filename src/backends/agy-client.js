// Antigravity CLI (agy) 后端适配器：实现与 NodeApiClient 兼容的会话/事件流接口
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { extractPresetPrefix } from '../preset-prompt.js';
import { BOUND_SESSION_ID_RE } from '../policy/self-key.js';
import { atomicWriteJson, readJsonSafe } from '../store/fs-atomic.js';

/** 非 closed-agent 会话默认禁止的本地执行与高危工具 */
export const DEFAULT_DISALLOWED_LOCAL_TOOLS = Object.freeze([
  'run_command',
  'bash',
  'pwsh',
  'write_file',
  'edit_file',
  'read_file',
  'delete_file',
  'apply_patch',
  'str_replace_editor',
  'list_dir',
  'find_by_name',
  'grep_search',
  'glob',
  'grep',
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'run_workflow',
  'swarm',
  'schedule',
  'manage_task',
  'browser',
]);

/** 非 closed-agent 会话默认允许的安全 MCP 工具前缀 */
export const DEFAULT_SAFE_ALLOWED_TOOLS = Object.freeze([
  'mcp__snowluma__*',
  'mcp__snowluma-host__*',
  'mcp__web-search-safe__*',
]);

/** 从预分配的 BOUND_SESSION_ID 反解会话 selfKey（group:xxx / private:xxx） */
export function decodeSelfKeyFromSessionId(sessionId) {
  const m = BOUND_SESSION_ID_RE.exec(String(sessionId ?? '').trim());
  if (!m) return '';
  const kind = String(sessionId).startsWith('qqb-g-') ? 'group' : 'private';
  return `${kind}:${m[1]}`;
}

/** 构造标准 RPC 成功/失败响应，兼容 unwrap() */
function okResult(value) {
  return { result: { ok: true, value } };
}
function errResult(code, message) {
  return { result: { ok: false, error: { code, message } } };
}

/** 解析单行 stream-json 输出（兼容 agy 的 event 字段与通用 type 字段） */
export function parseAgyStreamLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const kind = String(obj.event ?? obj.type ?? '').toLowerCase();
  const conversationId = obj.conversation_id
    ?? obj.conversationId
    ?? obj.session_id
    ?? obj.sessionId
    ?? obj.init?.conversation_id
    ?? obj.result?.conversation_id
    ?? null;

  if (kind === 'init' || kind === 'session_init') {
    return {
      kind: 'init',
      conversationId: conversationId ? String(conversationId) : null,
      model: obj.model ?? obj.init?.model ?? null,
    };
  }

  if (kind === 'step_update') {
    const step = obj.step_update ?? obj.data ?? obj;
    const textDelta = typeof step?.text_delta === 'string'
      ? step.text_delta
      : (typeof step?.delta === 'string' ? step.delta : '');
    const toolCall = step?.tool_call ?? step?.toolCall ?? null;
    const toolResult = step?.tool_result ?? step?.toolResult ?? null;
    if (toolCall && typeof toolCall === 'object') {
      return {
        kind: 'tool_call',
        callId: String(toolCall.call_id ?? toolCall.callId ?? toolCall.id ?? randomUUID()),
        name: String(toolCall.name ?? toolCall.tool_name ?? ''),
        arguments: toolCall.arguments ?? toolCall.args ?? toolCall.input ?? {},
      };
    }
    if (toolResult && typeof toolResult === 'object') {
      return {
        kind: 'tool_result',
        callId: String(toolResult.call_id ?? toolResult.callId ?? toolResult.id ?? ''),
        isError: toolResult.is_error === true || toolResult.isError === true || Boolean(toolResult.error),
        text: typeof toolResult.output === 'string'
          ? toolResult.output
          : (typeof toolResult.text === 'string'
            ? toolResult.text
            : (toolResult.error ? String(toolResult.error) : JSON.stringify(toolResult.content ?? ''))),
      };
    }
    if (textDelta) {
      return { kind: 'text_delta', text: textDelta };
    }
    return { kind: 'noop' };
  }

  if (kind === 'tool_use' || kind === 'tool_call') {
    return {
      kind: 'tool_call',
      callId: String(obj.call_id ?? obj.callId ?? obj.id ?? randomUUID()),
      name: String(obj.name ?? obj.tool_name ?? ''),
      arguments: obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {},
    };
  }

  if (kind === 'tool_result') {
    return {
      kind: 'tool_result',
      callId: String(obj.call_id ?? obj.callId ?? obj.tool_use_id ?? obj.id ?? ''),
      isError: obj.is_error === true || obj.isError === true || obj.status === 'error' || Boolean(obj.error),
      text: typeof obj.output === 'string'
        ? obj.output
        : (typeof obj.text === 'string' ? obj.text : String(obj.error ?? '')),
    };
  }

  if (kind === 'message' || kind === 'assistant') {
    if (obj.role && obj.role !== 'assistant' && obj.role !== 'model') return { kind: 'noop' };
    const text = typeof obj.content === 'string'
      ? obj.content
      : (typeof obj.text === 'string' ? obj.text : '');
    if (!text) return { kind: 'noop' };
    return obj.delta === true ? { kind: 'text_delta', text } : { kind: 'text_full', text };
  }

  if (kind === 'result' || kind === 'done') {
    const res = obj.result && typeof obj.result === 'object' ? obj.result : obj;
    const text = typeof res.text === 'string'
      ? res.text
      : (typeof res.response === 'string'
        ? res.response
        : (typeof res.output === 'string' ? res.output : ''));
    const usage = res.usage ?? obj.usage ?? null;
    const isError = res.is_error === true || obj.is_error === true || res.status === 'error' || Boolean(res.error);
    return {
      kind: 'result',
      conversationId: conversationId ? String(conversationId) : null,
      text,
      usage,
      model: res.model ?? obj.model ?? null,
      isError,
      error: isError ? String(res.error?.message ?? res.error ?? obj.error ?? 'agy execution failed') : null,
    };
  }

  if (kind === 'error') {
    return {
      kind: 'error',
      message: String(obj.error?.message ?? obj.message ?? obj.error ?? 'agy stream error'),
    };
  }

  return { kind: 'noop' };
}

/** 将 agy usage 对象归一化为 tokenLedger 可识别的格式 */
function normalizeAgyUsage(usage, model) {
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0) || 0;
  const cachedTokens = Number(usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? 0) || 0;
  if (!inputTokens && !outputTokens && !cachedTokens) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedTokens,
    ...(model ? { model } : {}),
  };
}

/** 把 content 数组转成 CLI 文本提示，并将图片落盘到会话临时目录 */
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
      } catch {
        // 落盘失败不阻断文本投递
      }
    }
  }

  let prompt = textParts.join('\n').trim();
  if (savedImages.length > 0) {
    prompt += `\n\n[附带图片本地路径]\n${savedImages.map((p) => `- ${p}`).join('\n')}`;
  }
  return prompt;
}

export class AgyApiClient {
  constructor(options = {}) {
    this.backendType = 'agy';
    this.backendLabel = 'Antigravity CLI';
    this.supportsPortDiscovery = false;

    this.command = String(options.command || 'agy').trim() || 'agy';
    this.extraArgs = Array.isArray(options.args) ? options.args.map(String) : [];
    this.defaultModel = String(options.model || '').trim();
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 5 * 60 * 1000;
    this.allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools.map(String).filter(Boolean) : [];
    this.disallowedTools = Array.isArray(options.disallowedTools) ? options.disallowedTools.map(String).filter(Boolean) : [];
    this.injectPresetPrompt = options.injectPresetPrompt !== false;
    this.rootDir = options.rootDir || process.cwd();
    this.stateDir = options.stateDir || '';
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this._spawn = options.spawn || spawn;
    this._checkAvailable = options.checkAvailable || null;

    this._sessionsFile = this.stateDir ? path.join(this.stateDir, 'agy-sessions.json') : '';
    this._sessions = new Map(); // sessionId -> session record
    this._workspaces = new Map(); // workspaceId -> { path, title }
    this._desiredFollows = new Set();
    this._listeners = new Set(); // active mux queues
    this._modeOverride = '';
    this._availabilityCache = { ok: false, checkedAt: 0 };

    this._loadPersistedSessions();
  }

  resolveBase() {
    return `agy://${this.command}`;
  }

  rebind() {
    return false;
  }

  hasAuth() {
    return true;
  }

  invalidateAuth() {}

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
        agyConversationId: meta.agyConversationId ? String(meta.agyConversationId) : '',
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
        agyConversationId: s.agyConversationId,
        turnCounter: s.turnCounter,
        eventSeq: s.eventSeq,
      };
    }
    try {
      atomicWriteJson(this._sessionsFile, out);
    } catch {}
  }

  _discoverPresets() {
    const presetsDir = path.join(this.rootDir, 'dsh', 'agent-presets');
    const presets = [];
    try {
      for (const entry of fs.readdirSync(presetsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const yml = path.join(presetsDir, entry.name, 'agent.cordis.yml');
        if (fs.existsSync(yml)) {
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
    const filePath = path.join(this.rootDir, 'dsh', 'agent-presets', safeName, 'agent.cordis.yml');
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return extractPresetPrefix(text) || '';
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
        const res = spawnSync(this.command, ['--version'], {
          stdio: 'ignore',
          timeout: 5000,
        });
        ok = !res.error && res.status === 0;
      } catch {
        ok = false;
      }
    }
    this._availabilityCache = { ok, checkedAt: now };
    return ok;
  }

  _emitSessionEvent(sessionId, event) {
    if (!this._desiredFollows.has(sessionId)) return;
    const session = this._sessions.get(sessionId);
    const seq = session ? (session.eventSeq += 1) : undefined;
    const envelope = {
      rpcId: `agy-${sessionId}-${seq ?? Date.now()}`,
      payload: {
        type: 'session/event',
        sessionId,
        event: { ...event, ...(seq !== undefined ? { seq } : {}) },
      },
    };
    for (const push of this._listeners) push(envelope);
  }

  settings = {
    describe: async () => {
      const ok = await this._isCliAvailable();
      if (!ok) {
        throw new Error(`Antigravity CLI (${this.command}) 不可用，请确认已安装并在 PATH 中，或在 config.json 的 backend.agy.command 指定完整路径`);
      }
      const namespaces = [
        { ns: 'agent-presets', values: { default: 'default' } },
      ];
      if (this._modeOverride) {
        namespaces.push({ ns: 'qq-mode', values: { mode: this._modeOverride } });
      }
      return okResult({ namespaces });
    },
    update: async ({ ns, patch } = {}) => {
      if (ns === 'qq-mode' && patch && typeof patch.mode === 'string') {
        this._modeOverride = patch.mode;
      }
      return okResult({ ok: true });
    },
  };

  agentPresets = {
    list: async () => okResult({ presets: this._discoverPresets() }),
  };

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
      const sid = String(sessionId || `agy-${randomUUID()}`);
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
        agyConversationId: '',
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
    list: async () => {
      const sessions = [...this._sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        workspaceId: s.cwd,
        agentPreset: s.agentPreset || undefined,
      }));
      return okResult({ sessions });
    },
    selectModel: async ({ sessionId, provider, model, reasoningEffort } = {}) => {
      const sid = String(sessionId ?? '');
      const session = this._sessions.get(sid);
      if (!session) return errResult('session/not-found', `session not found: ${sid}`);
      const chosen = String(model || this.defaultModel || 'default');
      session.model = chosen;
      this._persistSessions();
      return okResult({
        selected: {
          provider: provider || 'agy',
          model: chosen,
          reasoningEffort: reasoningEffort || null,
        },
      });
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
    const forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 3000);
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

  _buildCliArgs(session, promptText) {
    const args = [...this.extraArgs, '-p', promptText, '--output-format', 'stream-json'];
    if (session.agyConversationId) {
      args.push('--conversation', session.agyConversationId);
    }
    const model = session.model || this.defaultModel;
    if (model && model !== 'default' && model !== 'auto') {
      args.push('--model', model);
    }
    if (session.systemPrompt && !session.agyConversationId && this.injectPresetPrompt) {
      args.push('--system-prompt', session.systemPrompt);
    }
    if (session.restricted) {
      const allowed = this.allowedTools.length ? this.allowedTools : DEFAULT_SAFE_ALLOWED_TOOLS;
      const disallowed = this.disallowedTools.length ? this.disallowedTools : DEFAULT_DISALLOWED_LOCAL_TOOLS;
      if (allowed.length) args.push('--allowedTools', allowed.join(','));
      if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
    } else if (this.disallowedTools.length) {
      args.push('--disallowedTools', this.disallowedTools.join(','));
    }
    return args;
  }

  async _executeTurn(session, content) {
    session.turnCounter += 1;
    const turn = session.turnCounter;
    session.activeTurn = turn;
    session.cancelled = false;

    const promptText = materializePromptContent(content, session.cwd, turn);
    const args = this._buildCliArgs(session, promptText);
    const env = {
      ...process.env,
      ...(session.selfKey ? { QQ_BRIDGE_SELF_KEY: session.selfKey } : {}),
    };

    this._emitSessionEvent(session.sessionId, { type: 'turn/start', data: { turn } });

    let accumulatedText = '';
    let fullTextFromResult = '';
    let stderrBuf = '';
    let usage = undefined;
    let activeModel = session.model || this.defaultModel || 'agy';
    let streamError = null;

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
        child = this._spawn(this.command, args, {
          cwd: session.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        streamError = String(error?.message ?? error);
        finish();
        return;
      }

      session.activeChild = child;
      const killTimer = setTimeout(() => {
        streamError = `agy CLI 执行超时（${Math.round(this.timeoutMs / 1000)}s）`;
        this._killActiveChild(session);
      }, this.timeoutMs);
      killTimer.unref?.();

      let lineBuf = '';
      const handleLine = (rawLine) => {
        const parsed = parseAgyStreamLine(rawLine);
        if (!parsed || parsed.kind === 'noop') return;

        if (parsed.kind === 'init') {
          if (parsed.conversationId) {
            session.agyConversationId = parsed.conversationId;
            this._persistSessions();
          }
          if (parsed.model) {
            activeModel = parsed.model;
            this._emitSessionEvent(session.sessionId, {
              type: 'model/selection',
              data: { provider: 'agy', model: parsed.model },
            });
          }
          return;
        }

        if (parsed.kind === 'text_delta') {
          accumulatedText += parsed.text;
          this._emitSessionEvent(session.sessionId, {
            type: 'assistant/chunk',
            data: { turn, text: parsed.text },
          });
          return;
        }

        if (parsed.kind === 'text_full') {
          accumulatedText = parsed.text;
          return;
        }

        if (parsed.kind === 'tool_call') {
          this._emitSessionEvent(session.sessionId, {
            type: 'tool/call',
            data: {
              turn,
              callId: parsed.callId,
              name: parsed.name,
              arguments: parsed.arguments,
            },
          });
          return;
        }

        if (parsed.kind === 'tool_result') {
          this._emitSessionEvent(session.sessionId, {
            type: 'tool/result',
            data: {
              turn,
              message: {
                source: { callId: parsed.callId },
                isError: parsed.isError,
                content: [{ type: 'text', text: parsed.text, isError: parsed.isError }],
              },
            },
          });
          return;
        }

        if (parsed.kind === 'result') {
          if (parsed.conversationId) {
            session.agyConversationId = parsed.conversationId;
            this._persistSessions();
          }
          if (parsed.model) activeModel = parsed.model;
          if (parsed.text) fullTextFromResult = parsed.text;
          if (parsed.usage) usage = normalizeAgyUsage(parsed.usage, activeModel);
          if (parsed.isError && parsed.error) streamError = parsed.error;
          return;
        }

        if (parsed.kind === 'error') {
          streamError = parsed.message;
        }
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
        if (stderrBuf.length < 4096) stderrBuf += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        streamError = String(error?.message ?? error);
        finish();
      });

      child.on('close', (code) => {
        if (lineBuf.trim()) handleLine(lineBuf);
        if (!session.cancelled && code !== 0 && !streamError) {
          const tail = stderrBuf.trim().slice(-400);
          streamError = tail || `agy CLI exited with code ${code}`;
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
          provider: 'agy',
          ...(usage ? { usage } : {}),
          message: {
            role: 'assistant',
            content: finalText ? [{ type: 'text', text: finalText }] : [],
          },
        },
      });
    }

    const reason = session.cancelled
      ? { kind: 'cancelled' }
      : (streamError ? { kind: 'error', message: streamError } : { kind: 'completed' });

    this._emitSessionEvent(session.sessionId, {
      type: 'turn/end',
      data: { turn, reason },
    });
    this._persistSessions();
  }

  async callUnary(method) {
    const endpoint = String(method ?? '').replace(/\./g, '/');
    if (endpoint === 'session/modelCatalog' || endpoint === 'session/models') {
      const modelId = this.defaultModel || 'default';
      return {
        rpcId: `agy-${randomUUID()}`,
        ...okResult({
          groups: [{
            id: 'agy',
            name: 'Antigravity CLI',
            models: [{ id: modelId, name: modelId }],
          }],
        }),
      };
    }
    return {
      rpcId: `agy-${randomUUID()}`,
      ...errResult('method/not-supported', `agy backend does not support ${endpoint}`),
    };
  }

  async respond() {
    return okResult({ ok: true });
  }

  events = {
    mux: (_payload, signal, onOpen) => this._openEventStream(signal, onOpen),
    host: (_payload, signal, onOpen) => this._openEventStream(signal, onOpen),
    follow: (sessionId) => {
      if (sessionId) this._desiredFollows.add(String(sessionId));
    },
    forget: (sessionId) => {
      if (sessionId) this._desiredFollows.delete(String(sessionId));
    },
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
    const push = (envelope) => {
      if (ended) return;
      inbox.push(envelope);
      wake?.();
      wake = undefined;
    };
    const stop = () => {
      ended = true;
      wake?.();
      wake = undefined;
    };
    this._listeners.add(push);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      if (!ended) onOpen?.();
      while (!ended) {
        while (inbox.length > 0) {
          yield inbox.shift();
        }
        if (ended) break;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      this._listeners.delete(push);
      signal?.removeEventListener('abort', stop);
    }
  }
}
