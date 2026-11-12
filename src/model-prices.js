// DeepSeek 价目表与峰谷判定（元/百万 token）；
// 三个 token 桶互不重叠，须分别计价再相加

/** 价目表版本标记，改价目表时更新 */
export const PRICE_TABLE_VERSION = '2026-11-04';

/** 2026 年法定节假日，高峰判定须排除 */
export const CN_HOLIDAYS_2026 = [
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07'
];

/** 2027 年法定节假日；缺失会被当高峰而高估 */
export const CN_HOLIDAYS_2027 = [
  // 元旦
  '2027-01-01', '2027-01-02', '2027-01-03',
  // 春节（按农历推定）
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  // 清明节
  '2027-04-04', '2027-04-05', '2027-04-06',
  // 劳动节
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  // 端午节
  '2027-06-09', '2027-06-10', '2027-06-11',
  // 中秋节
  '2027-09-15', '2027-09-16', '2027-09-17',
  // 国庆节
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07'
];

/** 全部内置法定节假日 */
export const CN_HOLIDAYS = [...CN_HOLIDAYS_2026, ...CN_HOLIDAYS_2027];

/** 北京时间相对 UTC 的分钟偏移 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/** 默认价目表：off 为空闲价，高峰价乘倍率 */
export const DEFAULT_PRICE_TABLE = {
  version: PRICE_TABLE_VERSION,
  currency: 'CNY',
  symbol: '¥',
  unit: 1e6,
  peakMultiplier: 2,
  // 高峰窗口：北京时间小时 [start, end)
  peakWindows: [[9, 12], [14, 18]],
  // 高峰只在周一至周五；1=周一 … 7=周日
  peakWeekdays: [1, 2, 3, 4, 5],
  holidays: CN_HOLIDAYS,
  models: {
    'deepseek-flash': {
      label: 'DeepSeek-V4.1-Flash',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-flash': {
      label: 'DeepSeek-V4.1-Flash（旧模型名）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-flash-vision-exp': {
      label: 'DeepSeek-V4.1-Flash（视觉实验名）',
      off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 }
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek-V4-Pro-0813',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    },
    'deepseek-pro': {
      label: 'DeepSeek-V4-Pro-0813（旧模型名）',
      off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
    }
  },
  // 不认识的模型按 flash 算，并标记为估算
  fallbackModel: 'deepseek-flash'
};

/** 合并 config.json 的 pricing 覆盖项，失败回落默认 */
export function resolvePriceTable(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { ...DEFAULT_PRICE_TABLE, models: { ...DEFAULT_PRICE_TABLE.models } };
  }
  const merged = {
    ...DEFAULT_PRICE_TABLE,
    ...override,
    models: { ...DEFAULT_PRICE_TABLE.models },
    peakWindows: Array.isArray(override.peakWindows) ? override.peakWindows : DEFAULT_PRICE_TABLE.peakWindows,
    peakWeekdays: Array.isArray(override.peakWeekdays) ? override.peakWeekdays : DEFAULT_PRICE_TABLE.peakWeekdays,
    holidays: Array.isArray(override.holidays) ? override.holidays : DEFAULT_PRICE_TABLE.holidays
  };
  if (override.models && typeof override.models === 'object' && !Array.isArray(override.models)) {
    for (const [name, entry] of Object.entries(override.models)) {
      const base = DEFAULT_PRICE_TABLE.models[name];
      if (!entry || typeof entry !== 'object') continue;
      const given = entry.off ?? {};
      const off = { ...(base?.off ?? DEFAULT_PRICE_TABLE.models[DEFAULT_PRICE_TABLE.fallbackModel].off), ...given };
      // 条目自己没写 cacheWrite 才跟随 cacheMiss
      if (!Number.isFinite(Number(given.cacheWrite))) off.cacheWrite = off.cacheMiss;
      merged.models[name] = { label: entry.label ?? base?.label ?? name, off };
    }
  }
  if (typeof merged.fallbackModel !== 'string' || !merged.models[merged.fallbackModel]) {
    merged.fallbackModel = DEFAULT_PRICE_TABLE.fallbackModel;
  }
  if (!Number.isFinite(merged.peakMultiplier) || merged.peakMultiplier <= 0) merged.peakMultiplier = 2;
  if (!Number.isFinite(merged.unit) || merged.unit <= 0) merged.unit = 1e6;
  if (typeof merged.version !== 'string' || !merged.version) merged.version = PRICE_TABLE_VERSION;
  return merged;
}

/** 时间戳换算成北京时间日历分量 */
export function beijingParts(atMs) {
  const d = new Date(Number(atMs) + BEIJING_OFFSET_MINUTES * 60000);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=周一 … 7=周日
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return {
    weekday,
    hour: d.getUTCHours(),
    date: `${d.getUTCFullYear()}-${month}-${day}`,
    clock: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  };
}

/** 判断某一时刻是否在高峰时段 */
export function isPeakAt(atMs, table = DEFAULT_PRICE_TABLE) {
  const ms = Number(atMs);
  if (!Number.isFinite(ms)) return false;
  const { weekday, hour, date } = beijingParts(ms);
  if (!table.peakWeekdays.includes(weekday)) return false;
  const holidays = table.holidays instanceof Set ? table.holidays : new Set(table.holidays ?? []);
  if (holidays.has(date)) return false;
  return (table.peakWindows ?? []).some(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && hour >= start && hour < end);
}

/** 取某模型在某一时刻的单价 */
export function ratesAt(model, atMs, table = DEFAULT_PRICE_TABLE) {
  const key = String(model ?? '').trim();
  const entry = table.models[key];
  const chosen = entry ?? table.models[table.fallbackModel];
  const off = chosen.off;
  const peak = isPeakAt(atMs, table);
  const factor = peak ? table.peakMultiplier : 1;
  return {
    model: key || table.fallbackModel,
    label: chosen.label,
    tier: peak ? 'peak' : 'off',
    tierLabel: peak ? '高峰时段' : '空闲时段',
    currency: table.currency,
    symbol: table.symbol,
    unit: table.unit,
    estimated: !entry,
    cacheHit: off.cacheHit * factor,
    cacheMiss: off.cacheMiss * factor,
    cacheWrite: (Number.isFinite(off.cacheWrite) ? off.cacheWrite : off.cacheMiss) * factor,
    output: off.output * factor
  };
}

/** usage 归一成计费桶；DSH 与账本两种键名都要读 */
export function normalizeUsage(usage) {
  // 取首个有效正数键值，四舍五入
  const pick = (value, ...keys) => {
    for (const key of keys) {
      const v = Number(value?.[key]);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
    return 0;
  };
  if (!usage || typeof usage !== 'object') {
    return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  }
  return {
    // DSH 的 inputTokens 是未命中部分
    cacheMiss: pick(usage, 'cacheMiss', 'uncachedInputTokens', 'inputTokens'),
    cacheHit: pick(usage, 'cacheHit', 'cacheReadTokens'),
    cacheWrite: pick(usage, 'cacheWrite', 'cacheWriteTokens'),
    output: pick(usage, 'output', 'outputTokens'),
    reasoning: pick(usage, 'reasoning', 'reasoningTokens')
  };
}

/** 四个桶求和 */
export function totalTokensOf(buckets) {
  return (buckets?.cacheMiss ?? 0) + (buckets?.cacheHit ?? 0) + (buckets?.cacheWrite ?? 0) + (buckets?.output ?? 0);
}

/** 按单价把 token 桶折算成金额 */
export function costOfBuckets(buckets, rates) {
  const b = buckets ?? {};
  const cacheHit = ((b.cacheHit ?? 0) / rates.unit) * rates.cacheHit;
  const cacheMiss = ((b.cacheMiss ?? 0) / rates.unit) * rates.cacheMiss;
  const cacheWrite = ((b.cacheWrite ?? 0) / rates.unit) * rates.cacheWrite;
  const output = ((b.output ?? 0) / rates.unit) * rates.output;
  return {
    cacheHit,
    cacheMiss,
    cacheWrite,
    output,
    total: cacheHit + cacheMiss + cacheWrite + output
  };
}

/** 按桶、时间、模型直接算钱 */
export function priceUsage(buckets, { model, at, table = DEFAULT_PRICE_TABLE } = {}) {
  const rates = ratesAt(model, at, table);
  return { rates, cost: costOfBuckets(buckets, rates) };
}

/** 空桶常量 */
export const ZERO_BUCKETS = Object.freeze({ cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/** 桶相加 */
export function addBuckets(a, b) {
  return {
    cacheMiss: (a?.cacheMiss ?? 0) + (b?.cacheMiss ?? 0),
    cacheHit: (a?.cacheHit ?? 0) + (b?.cacheHit ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0)
  };
}

/** 桶相减，逐桶下限为 0 */
export function subBuckets(a, b) {
  // 每项相减，最多减到 0
  const s = (x, y) => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    cacheMiss: s(a?.cacheMiss, b?.cacheMiss),
    cacheHit: s(a?.cacheHit, b?.cacheHit),
    cacheWrite: s(a?.cacheWrite, b?.cacheWrite),
    output: s(a?.output, b?.output),
    reasoning: s(a?.reasoning, b?.reasoning)
  };
}
