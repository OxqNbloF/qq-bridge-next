/** 按聊天查出用哪个模式、预设、模型和思考强度 */

/** 仿真模式：无本地工具、受白名单限制，是安全默认 */
const SIMULATION_MODES = Object.freeze(['chat', 'reserved', 'reserved2']);

/** 可接受的模式拼写；simulation 保持原名，不折叠成旧名 */
const MODE_ALIASES = Object.freeze({
  simulation: 'simulation',
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  'closed-agent': 'closed-agent',
});

/** 所有内部模式名 */
const ALL_MODES = Object.freeze([...SIMULATION_MODES, 'simulation', 'closed-agent']);

/** 各模式允许的 preset；closed-agent 只能用其封闭 preset */
const DEFAULT_MODE_PRESETS = Object.freeze({
  chat: Object.freeze(['qq-chat']),
  reserved: Object.freeze(['qq-chat']),
  reserved2: Object.freeze(['qq-chat-v2']),
  simulation: Object.freeze(['qq-chat-v2']),
  'closed-agent': Object.freeze(['standard']),
});

/** 用调用方传入的 preset 名构建模式表，缺省用默认值 */
function buildModePresets(overrides = {}) {
  const out = {};
  for (const mode of ALL_MODES) {
    const list = overrides[mode];
    if (list === undefined) { out[mode] = DEFAULT_MODE_PRESETS[mode]; continue; }
    if (!Array.isArray(list) || list.length === 0
      || list.some((p) => typeof p !== 'string' || p.trim() !== p || p.length === 0)) {
      throw new TypeError(`presets for ${mode} must be a non-empty array of trimmed strings`);
    }
    out[mode] = Object.freeze([...list]);
  }
  return Object.freeze(out);
}

/** 旧模式名 -> 规范 simulation */
export const LEGACY_TO_CANONICAL = Object.freeze({
  chat: 'simulation',
  reserved: 'simulation',
  reserved2: 'simulation',
  'closed-agent': 'closed-agent',
  simulation: 'simulation',
});

/** 各模式能力说明；真正的拦截在 preset 工具守卫 */
const PERMISSIONS = Object.freeze({
  simulation: Object.freeze({ localExecution: false, localFiles: false, adminCommands: false }),
  'closed-agent': Object.freeze({ localExecution: true, localFiles: true, adminCommands: true }),
});

// 检查对象自己有没有这个字段（不算继承来的）
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 是否为普通对象
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** 把聊天编号整理成标准写法，不合法就返回 null */
export function canonicalConversationKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

// key 不合法时抛错
function requireKey(key) {
  const c = canonicalConversationKey(key);
  if (c === null) throw new TypeError(`Invalid conversation key: ${String(key)}`);
  return c;
}

/** ownerQQ 可为数字或数字串，其他视为配置错误 */
function normalizeOwnerQQ(ownerQQ) {
  if (ownerQQ === null || ownerQQ === undefined || ownerQQ === '') return null;
  const t = typeof ownerQQ;
  if (t !== 'string' && t !== 'number') {
    throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  }
  const c = canonicalConversationKey(`private:${String(ownerQQ).trim()}`);
  if (c === null) throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  return Number(c.slice('private:'.length));
}

// 检查可选文字字段写得对不对
function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be null or a non-empty trimmed string`);
  }
  return value;
}

/** 把模式拼写映射为内部名；只收字符串，防对象 toString 伪装 */
export function normalizeMode(mode) {
  if (typeof mode !== 'string') {
    throw new TypeError(`Unknown mode: expected a string, got ${typeof mode}`);
  }
  const m = mode.trim();
  if (!Object.prototype.hasOwnProperty.call(MODE_ALIASES, m)) {
    throw new TypeError(`Unknown mode: ${mode}`);
  }
  return MODE_ALIASES[m];
}

/** 检查是谁改的；首次启动和迁移只在最开始允许 */
function requireUpdatedBy(updatedBy, ownerKey, { allowSystem = false } = {}) {
  if (updatedBy === 'console') return updatedBy;
  if (ownerKey !== null && updatedBy === `command:${ownerKey}`) return updatedBy;
  if (allowSystem && (updatedBy === 'first-run' || updatedBy === 'migration')) return updatedBy;
  throw new TypeError('updatedBy must identify console or the owner private command');
}

/** 检查一条设置；顺序不能变：先看是谁改的，再看模式和预设 */
function normalizePolicy(record, label, ownerKey, modePresets, { isDefault = false } = {}) {
  if (!isPlainObject(record)) throw new TypeError(`${label} must be an object`);
  if (!isDefault) {
    requireUpdatedBy(record.updatedBy, ownerKey, { allowSystem: true });
  }
  if (!own(record, 'mode')) throw new TypeError(`${label} requires mode`);

  const mode = normalizeMode(record.mode);

  // 预设必须写明，不能在这里偷偷给默认值
  if (!own(record, 'preset') || record.preset === null) {
    throw new TypeError(`${label} requires an explicit preset`);
  }
  if (typeof record.preset !== 'string' || !modePresets[mode].includes(record.preset)) {
    throw new TypeError(`${label} has an unknown or unsafe preset for ${mode}`);
  }
  const preset = record.preset;

  if (isDefault && mode === 'closed-agent') {
    throw new TypeError('defaults must remain simulation (closed-agent is per-conversation only)');
  }
  // closed-agent 只能用于管理员私聊
  if (mode === 'closed-agent' && label !== ownerKey) {
    throw new TypeError(ownerKey === null
      ? 'closed-agent is restricted to the owner private conversation (no ownerQQ is configured)'
      : 'closed-agent is restricted to the owner private conversation');
  }

  const normalized = { mode, preset };
  if (isDefault) {
    normalized.model = own(record, 'model') ? optionalText(record.model, `${label}.model`) : null;
    normalized.reasoningEffort = own(record, 'reasoningEffort')
      ? optionalText(record.reasoningEffort, `${label}.reasoningEffort`) : null;
    return normalized;
  }

  normalized.updatedBy = record.updatedBy;
  if (own(record, 'model')) normalized.model = optionalText(record.model, `${label}.model`);
  if (own(record, 'reasoningEffort')) {
    normalized.reasoningEffort = optionalText(record.reasoningEffort, `${label}.reasoningEffort`);
  }
  return normalized;
}

// 把整份会话状态整理好并检查一遍
function normalizeState(state, ownerQQ, modePresets) {
  if (!isPlainObject(state) || state.version !== 1) {
    throw new TypeError('conversation state must have version 1');
  }
  const defaults = normalizePolicy(state.defaults, 'defaults', null, modePresets, { isDefault: true });
  if (!isPlainObject(state.conversations)) throw new TypeError('conversations must be an object');

  // 先查有没有重复编号再检查内容，结果和字段顺序无关
  const rawKeys = new Map();
  for (const rawKey of Object.keys(state.conversations)) {
    const key = requireKey(rawKey);
    if (rawKeys.has(key)) throw new TypeError(`Duplicate conversation key: ${key}`);
    rawKeys.set(key, rawKey);
  }

  const ownerKey = ownerQQ === null ? null : `private:${ownerQQ}`;
  const conversations = {};
  for (const [key, rawKey] of rawKeys) {
    conversations[key] = normalizePolicy(state.conversations[rawKey], key, ownerKey, modePresets);
  }
  return { version: 1, defaults, conversations };
}

/**
 * 做出最初的会话状态（每个聊天用什么模式、什么预设）。
 * @param {object} options 默认模式和是否启用封闭模式
 */
export function createInitialConversationState(ownerQQ, {
  defaultMode = null,
  closedAgentEnabled = true,
  modePresets,
} = {}) {
  const owner = normalizeOwnerQQ(ownerQQ);
  if (typeof closedAgentEnabled !== 'boolean') {
    throw new TypeError('closedAgentEnabled must be boolean');
  }
  const presets = modePresets ?? buildModePresets();

  // 默认模式不能是 closed-agent；旧拼写归为 simulation
  const requested = (defaultMode === null || defaultMode === undefined || defaultMode === '')
    ? null
    : normalizeMode(defaultMode);
  const safeDefault = (requested === null || requested === 'closed-agent')
    ? 'simulation'
    : LEGACY_TO_CANONICAL[requested];

  const conversations = {};
  // 已知管理员且未关闭时，管理员私聊默认 closed-agent
  if (owner !== null && closedAgentEnabled) {
    conversations[`private:${owner}`] = {
      mode: 'closed-agent',
      preset: presets['closed-agent'][0],
      model: null,
      reasoningEffort: null,
      updatedBy: 'first-run',
    };
  }
  return {
    version: 1,
    defaults: {
      mode: safeDefault,
      preset: presets[safeDefault][0],
      model: null,
      reasoningEffort: null,
    },
    conversations,
  };
}

/** 把全局模式改成每个聊天各自的状态，返回要写进文件的事件 */
export function migrateLegacyMode({ mode, ownerQQ, modePresets } = {}) {
  if (!ALL_MODES.includes(mode)) {
    throw new TypeError('Unknown legacy mode; refusing migration');
  }
  const owner = normalizeOwnerQQ(ownerQQ);
  const closedAgentEnabled = mode === 'closed-agent' && owner !== null;
  const state = createInitialConversationState(owner, {
    defaultMode: mode,
    closedAgentEnabled,
    modePresets,
  });
  // 迁移总要产生审计事件，不能静默返回空
  const events = [{
    type: 'legacy-mode-migrated',
    from: mode,
    to: closedAgentEnabled ? 'closed-agent for owner private; default elsewhere' : `default ${state.defaults.mode}`,
    ownerKey: closedAgentEnabled ? `private:${owner}` : null,
    reason: mode === 'closed-agent' && owner === null ? 'missing ownerQQ; downgraded' : null,
  }];
  if (closedAgentEnabled) state.conversations[`private:${owner}`].updatedBy = 'migration';
  return { state, events };
}

/** 只读策略查询；配置变化时重建，不可修改 */
export class SessionRouter {
  #ownerQQ;
  #defaultMode;
  #state;
  #now;
  #modePresets;

  // 检查并读入最初的状态
  constructor({ ownerQQ = null, defaultMode = 'reserved2', state, now = Date.now, modePresets } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
    this.#ownerQQ = normalizeOwnerQQ(ownerQQ);
    this.#modePresets = modePresets ?? buildModePresets();

    const init = state === undefined
      ? createInitialConversationState(this.#ownerQQ, { defaultMode, modePresets: this.#modePresets })
      : state;
    // 加载算第一次启动，允许 first-run/migration 这两种来源
    this.#state = normalizeState(init, this.#ownerQQ, this.#modePresets);

    // 显式 defaultMode 优先；不能引入 closed-agent 默认
    const dm = normalizeMode(defaultMode);
    if (dm !== 'closed-agent') this.#state.defaults.mode = LEGACY_TO_CANONICAL[dm];
    this.#defaultMode = this.#state.defaults.mode;
  }

  get ownerQQ() { return this.#ownerQQ; }
  get defaultMode() { return this.#defaultMode; }
  /** 调用方提供的各模式允许 preset */
  get modePresets() { return this.#modePresets; }

  // 生成审计事件时间戳
  #auditAt() {
    const at = this.#now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new TypeError('audit time must be a non-negative safe integer in milliseconds');
    }
    return at;
  }

  snapshot() { return structuredClone(this.#state); }

  /** 会话的显式覆盖项，无则 null */
  overrideFor(key) {
    const canonical = requireKey(key);
    return own(this.#state.conversations, canonical) ? this.#state.conversations[canonical] : null;
  }

  /** 查这个聊天用什么设置；默认不返回特殊权限模式 */
  policyFor(key) {
    const canonical = requireKey(key);
    const record = this.#state.conversations[canonical] ?? this.#state.defaults;
    const defaults = this.#state.defaults;
    const mode = record.mode;

    // 预设已经检查过，这里的回退只是最后保底
    const preset = own(record, 'preset') && record.preset
      ? record.preset
      : this.#modePresets[mode][0];

    return Object.freeze({
      key: canonical,
      mode,
      canonicalMode: LEGACY_TO_CANONICAL[mode],
      preset,
      model: own(record, 'model') ? record.model : defaults.model,
      reasoningEffort: own(record, 'reasoningEffort')
        ? record.reasoningEffort : defaults.reasoningEffort,
      hasOverride: own(this.#state.conversations, canonical),
    });
  }

  /** 会话的规范模式：closed-agent 或 simulation，不漏旧拼写 */
  modeFor(key) { return this.policyFor(key).canonicalMode; }

  /** modeFor 的同义方法 */
  canonicalModeFor(key) { return this.policyFor(key).canonicalMode; }

  /** 内部存储拼写，仅兼容判断用；业务代码用 modeFor */
  internalModeFor(key) { return this.policyFor(key).mode; }

  presetFor(key) { return this.policyFor(key).preset; }
  modelFor(key) { return this.policyFor(key).model; }
  effortFor(key) { return this.policyFor(key).reasoningEffort; }

  permissionsFor(key) { return PERMISSIONS[this.canonicalModeFor(key)]; }

  /** 会话能否运行其模式；closed-agent 仅限管理员私聊 */
  modeAllowsKey(key) {
    const canonical = canonicalConversationKey(key);
    if (canonical === null) return false;
    if (this.modeFor(canonical) !== 'closed-agent') return true;
    return this.#ownerQQ !== null && canonical === `private:${this.#ownerQQ}`;
  }

  /** 策略指纹；变化即需重建会话 */
  policyFingerprint(key) {
    const { mode, preset, model, reasoningEffort } = this.policyFor(key);
    return JSON.stringify([mode, preset, model, reasoningEffort, this.#ownerQQ]);
  }

  /** 设置这个聊天的单独配置；调用方要把返回的审计事件写进文件 */
  setConversation(key, record) {
    const canonical = requireKey(key);
    const ownerKey = this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`;
    // 这里不接受首次启动和迁移的来源，先检查是谁改的再检查内容
    requireUpdatedBy(record?.updatedBy, ownerKey, { allowSystem: false });

    const before = this.policyFor(canonical);
    const beforeFp = this.policyFingerprint(canonical);
    const hadOverride = own(this.#state.conversations, canonical);

    const candidate = {
      ...this.#state,
      conversations: { ...this.#state.conversations, [canonical]: record },
    };
    const next = normalizeState(candidate, this.#ownerQQ, this.#modePresets);
    const at = this.#auditAt();
    this.#state = next;

    const after = this.policyFor(canonical);
    const changedKeys = beforeFp === this.policyFingerprint(canonical) ? [] : [canonical];
    return Object.freeze({
      key: canonical,
      changedKeys,
      auditEvent: Object.freeze({
        type: 'conversation-set',
        key: canonical,
        updatedBy: next.conversations[canonical].updatedBy,
        at,
        // 审计记录完整的旧策略
        before,
        after,
        hadOverride,
        policyChanged: changedKeys.length > 0,
      }),
    });
  }

  /** 删除覆盖项，回落默认 */
  deleteConversation(key, { updatedBy } = {}) {
    const canonical = requireKey(key);
    const ownerKey = this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`;
    const actor = requireUpdatedBy(updatedBy, ownerKey, { allowSystem: false });

    const before = this.policyFor(canonical);
    const beforeFp = this.policyFingerprint(canonical);
    const hadOverride = own(this.#state.conversations, canonical);

    const conversations = { ...this.#state.conversations };
    delete conversations[canonical];
    const next = normalizeState({ ...this.#state, conversations }, this.#ownerQQ, this.#modePresets);
    const at = this.#auditAt();
    this.#state = next;

    const after = this.policyFor(canonical);
    const changedKeys = beforeFp === this.policyFingerprint(canonical) ? [] : [canonical];
    return Object.freeze({
      key: canonical,
      changedKeys,
      auditEvent: Object.freeze({
        type: 'conversation-deleted',
        key: canonical,
        updatedBy: actor,
        at,
        before,
        after,
        hadOverride,
        noOp: !hadOverride,
        policyChanged: changedKeys.length > 0,
      }),
    });
  }
}
