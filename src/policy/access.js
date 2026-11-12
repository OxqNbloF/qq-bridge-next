// 白名单、身份与会话 key 规范化（纯函数）

// 规范化 ownerQQ：空为未设置，须为正整数
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 规范化名单值：非数组按空列表处理
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

/** 发送者是否被忽略；管理员永不忽略 */
export function ignoredSender(id, cfg) {
  const sender = String(id ?? '');
  if (!sender || sender === String(cfg.ownerQQ ?? '')) return false;
  return Array.isArray(cfg.ignore?.sendQQ) && cfg.ignore.sendQQ.includes(sender);
}

/** 白名单判定：deny 优先，allow 非空须命中 */
export function allowed(kind, id, cfg) {
  // id 统一转字符串；兼容单复数字段名
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

/** 拼会话 key，如 group:123 */
export const convKey = (kind, id) => `${kind}:${id}`;

// 规范化二代会话 key，去前导零；非法返回 null
export function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}
