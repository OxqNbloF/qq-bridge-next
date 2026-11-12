// 把模式写法统一整理，并检查思考强度

/**
 * 把各种模式写法统一成内部名字，老名字也认。
 */
export const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合，由别名表派生 */
export const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 把模式名字统一，认不出来就返回 null */
export function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/** 读 DSH 设置项：user 层优先，否则回退 value */
export function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读不到设置时用这几档思考强度
export const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
export const REASONING_EFFORT_DEFAULT = 'max';
export const REASONING_EFFORT_NONE = 'none';
// 检查思考强度写得对不对，不对就报错
export function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim();
  if (!v || /\p{Cc}/u.test(v)) {
    throw new Error(`思考强度不能为空或包含控制字符；${REASONING_EFFORT_NONE} 表示不指定`);
  }
  // none 是特殊值；别的写法保持原样，不改大小写
  if (v.toLowerCase() === REASONING_EFFORT_NONE) return REASONING_EFFORT_NONE;
  return v;
}
