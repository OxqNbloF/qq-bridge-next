// v3 统一配置模式校验、热更新与密钥脱敏存储
import { z } from 'zod';
import { atomicWriteJson, readJsonSafe } from '../storage/fs-atomic.js';

export const CHAT_MODES = Object.freeze(['off', 'listen', 'chat', 'human', 'admin']);
export const BUILTIN_BACKENDS = Object.freeze(['dsh', 'agy', 'gemini']);
export const SECRET_MASK = '********';

export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function deepMergePlain(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = isPlainObject(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMergePlain(out[k], v);
    } else if (v !== undefined) {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

const IdListSchema = z.array(z.union([z.string(), z.number()])).transform((arr) =>
  [...new Set(arr.map((x) => String(x ?? '').trim()).filter(Boolean))],
);

const ChatOverrideSchema = z.object({
  mode: z.enum(CHAT_MODES).optional(),
  backend: z.string().trim().min(1).optional(),
  model: z.string().trim().optional(),
  paused: z.boolean().optional(),
  personaOverride: z.string().optional(),
});

const CliProfileSchema = z.object({
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

export const ConfigSchema = z.object({
  ownerQQ: z.union([z.string(), z.number()]).transform((v) => String(v ?? '').trim()),
  console: z.object({
    host: z.string().trim().min(1),
    port: z.number().int().min(0).max(65535),
    token: z.string(),
  }),
  onebot: z.object({
    wsUrl: z.string().trim().min(1),
    httpUrl: z.string().trim().min(1),
    accessToken: z.string(),
  }),
  access: z.object({
    allowGroups: IdListSchema,
    allowPrivate: IdListSchema,
    denyGroups: IdListSchema,
    denyPrivate: IdListSchema,
    ignoreUsers: IdListSchema,
    allowAllWhenEmpty: z.boolean(),
  }),
  modes: z.object({
    defaultGroup: z.enum(CHAT_MODES),
    defaultPrivate: z.enum(CHAT_MODES),
    chats: z.record(z.string(), ChatOverrideSchema),
  }),
  wake: z.object({
    coalesceMs: z.number().int().min(0).max(60000),
    cooldownMs: z.number().int().min(0).max(3600000),
    minUnreadBatch: z.number().int().min(1).max(200),
    defaultSleepMs: z.number().int().min(1000).max(86400000),
    minSleepMs: z.number().int().min(1000).max(86400000),
    maxSleepMs: z.number().int().min(1000).max(86400000),
    preSleepQuietMs: z.number().int().min(0).max(3600000),
    mustWakeKeywords: z.array(z.string()),
  }),
  persona: z.object({
    name: z.string().trim().min(1),
    prompt: z.string(),
  }),
  runtime: z.object({
    activeBackend: z.string().trim().min(1),
    activeModel: z.string().trim(),
    maxConcurrent: z.number().int().min(1).max(64),
    turnTimeoutMs: z.number().int().min(5000).max(1800000),
  }),
  backends: z.object({
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
    cliProfiles: z.record(z.string(), CliProfileSchema),
  }),
  broker: z.object({
    enabledModules: z.array(z.string().trim().min(1)),
    scriptTimeoutMs: z.number().int().min(1000).max(120000),
    useBwrap: z.boolean(),
  }),
  prompt: z.object({
    compactThresholdTokens: z.number().int().min(1000).max(2000000),
    maxUnreadInline: z.number().int().min(1).max(100),
  }),
  security: z.object({
    blockSensitiveOutbound: z.boolean(),
    rateLimitPerMinute: z.number().int().min(1).max(600),
    maxBurstMessages: z.number().int().min(1).max(10),
  }),
});

export const DEFAULT_CONFIG = Object.freeze({
  ownerQQ: '',
  console: {
    host: '127.0.0.1',
    port: 3100,
    token: '',
  },
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
  },
  access: {
    allowGroups: [],
    allowPrivate: [],
    denyGroups: [],
    denyPrivate: [],
    ignoreUsers: [],
    allowAllWhenEmpty: false,
  },
  modes: {
    defaultGroup: 'human',
    defaultPrivate: 'chat',
    chats: {},
  },
  wake: {
    coalesceMs: 2500,
    cooldownMs: 45000,
    minUnreadBatch: 6,
    defaultSleepMs: 900000,
    minSleepMs: 60000,
    maxSleepMs: 7200000,
    preSleepQuietMs: 120000,
    mustWakeKeywords: [],
  },
  persona: {
    name: '群友',
    prompt: '你是一个真实自然的群聊成员，说话简短口语化；无关话题或不该插嘴时保持克制沉默。',
  },
  runtime: {
    activeBackend: 'agy',
    activeModel: '',
    maxConcurrent: 4,
    turnTimeoutMs: 300000,
  },
  backends: {
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
      permissions: {
        allow: ['mcp(qq-broker/*)'],
        deny: [],
      },
    },
    gemini: {
      command: 'gemini',
      args: [],
      model: '',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      timeoutMs: 300000,
    },
    cliProfiles: {},
  },
  broker: {
    enabledModules: ['msg', 'memory', 'wake', 'media', 'social', 'web'],
    scriptTimeoutMs: 20000,
    useBwrap: false,
  },
  prompt: {
    compactThresholdTokens: 48000,
    maxUnreadInline: 20,
  },
  security: {
    blockSensitiveOutbound: true,
    rateLimitPerMinute: 20,
    maxBurstMessages: 4,
  },
});

const DEFAULT_CLI_PROFILE = Object.freeze({
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

function normalizeCliProfiles(rawProfiles) {
  if (!isPlainObject(rawProfiles)) return {};
  const out = {};
  for (const [id, spec] of Object.entries(rawProfiles)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new Error(`cliProfiles 名称非法：${id}`);
    out[id] = deepMergePlain(DEFAULT_CLI_PROFILE, spec);
  }
  return out;
}

/** 解析并校验完整配置 */
export function parseConfig(rawInput = {}) {
  const input = isPlainObject(rawInput) ? structuredClone(rawInput) : {};
  const merged = deepMergePlain(DEFAULT_CONFIG, input);
  merged.backends.cliProfiles = normalizeCliProfiles(input?.backends?.cliProfiles ?? merged.backends.cliProfiles);
  const parsed = ConfigSchema.parse(merged);

  if (parsed.wake.minSleepMs > parsed.wake.maxSleepMs) {
    const tmp = parsed.wake.minSleepMs;
    parsed.wake.minSleepMs = parsed.wake.maxSleepMs;
    parsed.wake.maxSleepMs = tmp;
  }
  if (parsed.wake.defaultSleepMs < parsed.wake.minSleepMs) parsed.wake.defaultSleepMs = parsed.wake.minSleepMs;
  if (parsed.wake.defaultSleepMs > parsed.wake.maxSleepMs) parsed.wake.defaultSleepMs = parsed.wake.maxSleepMs;

  const backendId = parsed.runtime.activeBackend;
  const knownBackends = new Set([...BUILTIN_BACKENDS, ...Object.keys(parsed.backends.cliProfiles)]);
  if (!knownBackends.has(backendId)) {
    throw new Error(`未知 activeBackend: ${backendId}`);
  }
  return parsed;
}

/** 控制台回显脱敏配置（隐藏密钥，附带 hasToken 标记） */
export function maskConfigSecrets(cfg) {
  const copy = structuredClone(cfg);
  copy.console = { ...copy.console, token: copy.console.token ? SECRET_MASK : '', hasToken: Boolean(cfg.console.token) };
  copy.onebot = { ...copy.onebot, accessToken: copy.onebot.accessToken ? SECRET_MASK : '', hasToken: Boolean(cfg.onebot.accessToken) };
  copy.backends.dsh = {
    ...copy.backends.dsh,
    authToken: copy.backends.dsh.authToken ? SECRET_MASK : '',
    hasToken: Boolean(cfg.backends.dsh.authToken),
  };
  return copy;
}

function preserveMaskedSecrets(patch, currentCfg) {
  const next = deepMergePlain({}, patch);
  if (next.console?.token === SECRET_MASK) next.console.token = currentCfg.console.token;
  if (next.onebot?.accessToken === SECRET_MASK) next.onebot.accessToken = currentCfg.onebot.accessToken;
  if (next.backends?.dsh?.authToken === SECRET_MASK) next.backends.dsh.authToken = currentCfg.backends.dsh.authToken;
  if (next.console?.token === null) next.console.token = '';
  if (next.onebot?.accessToken === null) next.onebot.accessToken = '';
  if (next.backends?.dsh?.authToken === null) next.backends.dsh.authToken = '';
  return next;
}

/** 创建可热更新的配置存储 */
export function createConfigStore({ configPath = '', initialConfig = null } = {}) {
  const disk = configPath ? readJsonSafe(configPath, null) : null;
  let current = parseConfig(initialConfig ?? disk ?? {});
  const listeners = new Set();

  function get() {
    return current;
  }

  function patch(partial) {
    if (!isPlainObject(partial)) throw new Error('配置补丁必须是 JSON 对象');
    const sanitizedPatch = preserveMaskedSecrets(partial, current);
    const candidate = deepMergePlain(current, sanitizedPatch);
    // 允许 chats 与 cliProfiles 全量替换条目（如删除单条）
    if (isPlainObject(sanitizedPatch.modes?.chats)) {
      for (const [k, v] of Object.entries(sanitizedPatch.modes.chats)) {
        if (v === null) delete candidate.modes.chats[k];
      }
    }
    if (isPlainObject(sanitizedPatch.backends?.cliProfiles)) {
      for (const [k, v] of Object.entries(sanitizedPatch.backends.cliProfiles)) {
        if (v === null) delete candidate.backends.cliProfiles[k];
      }
    }
    const prev = current;
    const validated = parseConfig(candidate);
    current = validated;
    if (configPath) {
      atomicWriteJson(configPath, validated, { mode: 0o600 });
    }
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
    return [current.console.token, current.onebot.accessToken, current.backends.dsh.authToken].filter(
      (x) => typeof x === 'string' && x.length >= 6,
    );
  }

  return { get, patch, onChange, listSecrets };
}
