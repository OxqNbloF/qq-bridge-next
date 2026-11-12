// 只压缩给模型看的视图，存储与控制台数据保留原字段
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

// 时间视图：把毫秒时间换成"几点"和"多久前"
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/** 本地时间：当天 HH:MM，跨天补 MM-DD */
function localStamp(ms, now) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  // 检查是不是同一天
  const sameDay = (() => {
    const a = new Date(now);
    return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth() && a.getDate() === d.getDate();
  })();
  return sameDay ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 距现在多久：3s/18m/2h/3d；未来时间夹到 0s */
function ageText(ms, now) {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

/** 把毫秒时间转成"多久以前"的文字 */
export function describeAge(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  return ageText(t, now);
}

// 净化群友文本：全角方括号转半角，去换行与零宽字符，
// 防止伪造【系统】段落
export function sanitizeUntrustedText(value) {
  return String(value ?? '')
    .replace(/\u3010/g, '[')
    .replace(/\u3011/g, ']')
    .replace(/[\r\n\u2028\u2029\u0085\u000b\u000c]+/g, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
}

// 是否普通对象（非数组、原型为 Object 或 null）
function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// 是否为空值、空串或空数组
function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

// 压缩媒体列表，按需去掉冗余引用
function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // 有本地消息号就能取图；转发节点保留传输引用
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // 与取图工具的从 1 计数一致，不过滤不重排
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

// 压缩单条消息给模型看
export function compactModelMessage(message, opts = {}) {
  if (typeof message === 'string') return sanitizeUntrustedText(message);
  if (!isRecord(message)) return message;
  const result = { ...message };
  // 先净化群友可控字段，必须在去重之前
  for (const key of ['sender', 'text', 'plain', 'tail']) {
    if (typeof result[key] === 'string') result[key] = sanitizeUntrustedText(result[key]);
  }
  // 不裁剪：plain 与 tail 可能含 text 没有的内容
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  // 有效时间换成 at/ago，缺失或 0 不动
  const stamp = Number(result.time);
  if (Number.isFinite(stamp) && stamp > 0) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    delete result.time;
    result.at = localStamp(stamp, now);
    result.ago = ageText(stamp, now);
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

// 压缩模型数据中的消息列表
export function compactModelData(data, opts = {}) {
  if (typeof data === 'string') return sanitizeUntrustedText(data);
  if (Array.isArray(data)) return data.map((item) => compactModelData(item, opts));
  if (!isRecord(data)) return data;
  // 一批消息只取一次 now，保证 ago 可比
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const inner = { now };
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map((item) => compactModelMessage(item, inner))
      : compactModelData(value, inner)
  ]));
}

// 整理好后存成 JSON 文本
export function serializeModelData(data, opts = {}) {
  return JSON.stringify(compactModelData(data, opts));
}
