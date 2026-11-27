// 全新 Zod 配置模式、热更新与密钥脱敏存储
import { z } from 'zod';
import { atomicWriteJson, readJsonSafe } from '../storage/fs-atomic.js';

export const ROOM_MODES = Object.freeze(['muted', 'observer', 'direct', 'ambient', 'operator']);
export const BUILTIN_ENGINES = Object.freeze(['dsh', 'agy', 'gemini']);
export const REDACTED_SECRET = '********';

export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function mergePlain(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = isPlainObject(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergePlain(out[k], v);
    } else if (v !== undefined) {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

const IdArraySchema = z.array(z.union([z.string(), z.number()])).transform((arr) =>
  [...new Set(arr.map((x) => String(x ?? '').trim()).filter(Boolean))],
);

const RoomOverrideSchema = z.object({
  mode: z.enum(ROOM_MODES).optional(),
  engine: z.string().trim().min(1).optional(),
  model: z.string().trim().optional(),
  paused: z.boolean().optional(),
  personaNote: z.string().optional(),
});

const CustomCliSchema = z.object({
  label: z.string().trim().min(1),
  command: z.string().trim().min(1),
  argsTemplate: z.array(z.string()),
  modelFlag: z.string(),
  resumeFlag: z.string(),
  outputFormat: z.enum(['jsonl', 'text']),
  model: z.string(),
  models: z.array(z.string()),
  timeoutMs: z.number().int().min(5000).max(1800000),
  env: z.record(z.string(), z.string()),
});

export const SettingsSchema = z.object({
  ownerId: z.union([z.string(), z.number()]).transform((v) => String(v ?? '').trim()),
  controlPlane: z.object({
    host: z.string().trim().min(1),
    port: z.number().int().min(0).max(65535),
    secret: z.string(),
  }),
  transport: z.object({
    wsUrl: z.string().trim().min(1),
    httpUrl: z.string().trim().min(1),
    token: z.string(),
  }),
  perimeter: z.object({
    allowedGroups: IdArraySchema,
    allowedDirects: IdArraySchema,
    blockedGroups: IdArraySchema,
    blockedDirects: IdArraySchema,
    mutedSenders: IdArraySchema,
    openWhenEmpty: z.boolean(),
  }),
  routing: z.object({
    defaultGroupMode: z.enum(ROOM_MODES),
    defaultDirectMode: z.enum(ROOM_MODES),
    rooms: z.record(z.string(), RoomOverrideSchema),
  }),
  memberPolicy: z.object({
    enabled: z.boolean(),
  }),
  pacing: z.object({
    coalesceMs: z.number().int().min(0).max(60000),
    cooldownMs: z.number().int().min(0).max(3600000),
    batchThreshold: z.number().int().min(1).max(200),
    dormantMs: z.number().int().min(1000).max(86400000),
    minDormantMs: z.number().int().min(1000).max(86400000),
    maxDormantMs: z.number().int().min(1000).max(86400000),
    quietWindowMs: z.number().int().min(0).max(3600000),
    triggerKeywords: z.array(z.string()),
  }),
  character: z.object({
    displayName: z.string().trim().min(1),
    instructions: z.string(),
    maxCardChars: z.number().int().min(200).max(32000),
    refreshEveryNWakes: z.number().int().min(0).max(50),
    maxIntroChars: z.number().int().min(100).max(8000),
  }),
  directory: z.object({
    enabled: z.boolean(),
    autoLearn: z.boolean(),
    revealRawId: z.boolean(),
    maxAliases: z.number().int().min(1).max(32),
  }),
  glossary: z.object({
    enabled: z.boolean(),
    maxInject: z.number().int().min(0).max(50),
  }),
  attachments: z.object({
    maxBytes: z.number().int().min(1024).max(33554432),
    maxPixels: z.number().int().min(1024).max(67108864),
    maxForwardDepth: z.number().int().min(1).max(8),
  }),
  emoticon: z.object({
    enabled: z.boolean(),
    maxInPrompt: z.number().int().min(0).max(32),
  }),
  audio: z.object({
    enabled: z.boolean(),
    libraryDir: z.string().trim().min(1),
    maxBytes: z.number().int().min(1024).max(52428800),
    perMinuteCap: z.number().int().min(1).max(60),
    perDayCap: z.number().int().min(1).max(1000),
  }),
  engine: z.object({
    active: z.string().trim().min(1),
    model: z.string().trim(),
    maxConcurrency: z.number().int().min(1).max(64),
    turnTimeoutMs: z.number().int().min(5000).max(1800000),
  }),
  engines: z.object({
    dsh: z.object({
      baseUrl: z.string().trim().min(1),
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      reasoningEffort: z.string().trim().min(1),
      authToken: z.string(),
      allowRemote: z.boolean(),
      agentPreset: z.string().trim(),
    }),
    agy: z.object({
      command: z.string().trim().min(1),
      args: z.array(z.string()),
      model: z.string().trim(),
      models: z.array(z.string()),
      timeoutMs: z.number().int().min(5000).max(1800000),
      permissions: z.object({
        allow: z.array(z.string()),
        deny: z.array(z.string()),
      }),
    }),
    gemini: z.object({
      command: z.string().trim().min(1),
      args: z.array(z.string()),
      model: z.string().trim(),
      models: z.array(z.string()),
      timeoutMs: z.number().int().min(5000).max(1800000),
    }),
    customCli: z.record(z.string(), CustomCliSchema),
  }),
  toolbox: z.object({
    enabledCapabilities: z.array(z.string().trim().min(1)),
    scriptTimeoutMs: z.number().int().min(1000).max(120000),
    useSandbox: z.boolean(),
  }),
  context: z.object({
    compactAtTokens: z.number().int().min(1000).max(2000000),
    maxInlineUnread: z.number().int().min(1).max(100),
  }),
  guard: z.object({
    blockSensitive: z.boolean(),
    maxPerMinute: z.number().int().min(1).max(600),
    maxBurst: z.number().int().min(1).max(10),
  }),
});

export const DEFAULT_SETTINGS = Object.freeze({
  ownerId: '',
  controlPlane: { host: '127.0.0.1', port: 3100, secret: '' },
  transport: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', token: '' },
  perimeter: {
    allowedGroups: [],
    allowedDirects: [],
    blockedGroups: [],
    blockedDirects: [],
    mutedSenders: [],
    openWhenEmpty: false,
  },
  routing: { defaultGroupMode: 'ambient', defaultDirectMode: 'direct', rooms: {} },
  memberPolicy: { enabled: false },
  pacing: {
    coalesceMs: 2500,
    cooldownMs: 45000,
    batchThreshold: 6,
    dormantMs: 900000,
    minDormantMs: 60000,
    maxDormantMs: 7200000,
    quietWindowMs: 120000,
    triggerKeywords: [],
  },
  character: {
    displayName: '群友',
    instructions: '你是一个真实自然的群聊成员，说话简短口语化；无关话题或不该插嘴时保持克制沉默。',
    maxCardChars: 4000,
    refreshEveryNWakes: 4,
    maxIntroChars: 1000,
  },
  directory: { enabled: true, autoLearn: true, revealRawId: false, maxAliases: 8 },
  glossary: { enabled: true, maxInject: 12 },
  attachments: { maxBytes: 3145728, maxPixels: 16777216, maxForwardDepth: 3 },
  emoticon: { enabled: true, maxInPrompt: 8 },
  audio: { enabled: false, libraryDir: 'data/audio', maxBytes: 20971520, perMinuteCap: 3, perDayCap: 20 },
  engine: { active: 'agy', model: '', maxConcurrency: 4, turnTimeoutMs: 300000 },
  engines: {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      authToken: '',
      allowRemote: false,
      agentPreset: '',
    },
    agy: {
      command: 'agy',
      args: [],
      model: '',
      models: [],
      timeoutMs: 300000,
      permissions: { allow: ['mcp(relay-hub/*)'], deny: [] },
    },
    gemini: {
      command: 'gemini',
      args: [],
      model: '',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      timeoutMs: 300000,
    },
    customCli: {},
  },
  toolbox: {
    enabledCapabilities: ['chat', 'notes', 'pacing', 'attach', 'people', 'browse', 'emoticon', 'audio'],
    scriptTimeoutMs: 20000,
    useSandbox: false,
  },
  context: { compactAtTokens: 48000, maxInlineUnread: 20 },
  guard: { blockSensitive: true, maxPerMinute: 20, maxBurst: 4 },
});

const DEFAULT_CUSTOM_CLI = Object.freeze({
  label: 'Custom CLI',
  command: '',
  argsTemplate: ['-p', '{{prompt}}'],
  modelFlag: '--model',
  resumeFlag: '--resume',
  outputFormat: 'text',
  model: '',
  models: [],
  timeoutMs: 300000,
  env: {},
});

function normalizeCustomCli(rawMap) {
  if (!isPlainObject(rawMap)) return {};
  const out = {};
  for (const [id, spec] of Object.entries(rawMap)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new Error(`customCli 名称非法：${id}`);
    out[id] = mergePlain(DEFAULT_CUSTOM_CLI, spec);
  }
  return out;
}

export function parseSettings(rawInput = {}) {
  const input = isPlainObject(rawInput) ? structuredClone(rawInput) : {};
  const merged = mergePlain(DEFAULT_SETTINGS, input);
  merged.engines.customCli = normalizeCustomCli(input?.engines?.customCli ?? merged.engines.customCli);
  const parsed = SettingsSchema.parse(merged);

  if (parsed.pacing.minDormantMs > parsed.pacing.maxDormantMs) {
    const t = parsed.pacing.minDormantMs;
    parsed.pacing.minDormantMs = parsed.pacing.maxDormantMs;
    parsed.pacing.maxDormantMs = t;
  }
  if (parsed.pacing.dormantMs < parsed.pacing.minDormantMs) parsed.pacing.dormantMs = parsed.pacing.minDormantMs;
  if (parsed.pacing.dormantMs > parsed.pacing.maxDormantMs) parsed.pacing.dormantMs = parsed.pacing.maxDormantMs;

  const known = new Set([...BUILTIN_ENGINES, ...Object.keys(parsed.engines.customCli)]);
  if (!known.has(parsed.engine.active)) {
    throw new Error(`未知 engine.active: ${parsed.engine.active}`);
  }
  return parsed;
}

export function redactSettingsSecrets(cfg) {
  const copy = structuredClone(cfg);
  copy.controlPlane = {
    ...copy.controlPlane,
    secret: copy.controlPlane.secret ? REDACTED_SECRET : '',
    hasSecret: Boolean(cfg.controlPlane.secret),
  };
  copy.transport = {
    ...copy.transport,
    token: copy.transport.token ? REDACTED_SECRET : '',
    hasToken: Boolean(cfg.transport.token),
  };
  copy.engines.dsh = {
    ...copy.engines.dsh,
    authToken: copy.engines.dsh.authToken ? REDACTED_SECRET : '',
    hasToken: Boolean(cfg.engines.dsh.authToken),
  };
  return copy;
}

function preserveRedactedSecrets(patch, current) {
  const next = mergePlain({}, patch);
  if (next.controlPlane?.secret === REDACTED_SECRET) next.controlPlane.secret = current.controlPlane.secret;
  if (next.transport?.token === REDACTED_SECRET) next.transport.token = current.transport.token;
  if (next.engines?.dsh?.authToken === REDACTED_SECRET) next.engines.dsh.authToken = current.engines.dsh.authToken;
  if (next.controlPlane?.secret === null) next.controlPlane.secret = '';
  if (next.transport?.token === null) next.transport.token = '';
  if (next.engines?.dsh?.authToken === null) next.engines.dsh.authToken = '';
  return next;
}

export function createSettingsStore({ configPath = '', initialConfig = null } = {}) {
  const disk = configPath ? readJsonSafe(configPath, null) : null;
  let current = parseSettings(initialConfig ?? disk ?? {});
  const listeners = new Set();

  function get() { return current; }

  function patch(partial) {
    if (!isPlainObject(partial)) throw new Error('配置补丁必须是 JSON 对象');
    const cleanPatch = preserveRedactedSecrets(partial, current);
    const candidate = mergePlain(current, cleanPatch);
    if (isPlainObject(cleanPatch.routing?.rooms)) {
      for (const [k, v] of Object.entries(cleanPatch.routing.rooms)) {
        if (v === null) delete candidate.routing.rooms[k];
      }
    }
    if (isPlainObject(cleanPatch.engines?.customCli)) {
      for (const [k, v] of Object.entries(cleanPatch.engines.customCli)) {
        if (v === null) delete candidate.engines.customCli[k];
      }
    }
    const prev = current;
    const validated = parseSettings(candidate);
    current = validated;
    if (configPath) atomicWriteJson(configPath, validated, { mode: 0o600 });
    for (const fn of listeners) {
      try { fn(validated, prev); } catch {}
    }
    return validated;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function listSecrets() {
    return [current.controlPlane.secret, current.transport.token, current.engines.dsh.authToken].filter(
      (x) => typeof x === 'string' && x.length >= 6,
    );
  }

  return { get, patch, onChange, listSecrets };
}
