// 状态文件 schemaVersion 与迁移；版本过新只读不回写

export const SCHEMA_KEY = 'schemaVersion';

/** 各受管文件的当前版本；升级须在 MIGRATIONS 登记 */
export const SCHEMA_VERSIONS = Object.freeze({
  sessions: 1,
  'social-v2': 1,
  'initial-prompts': 1,
  'role-inject': 1,
  archive: 1,
  conversations: 1,
  pool: 1,
});

/** MIGRATIONS[name][from] 把文档迁到 from + 1 */
const MIGRATIONS = Object.freeze({
  sessions: { 0: (doc) => doc },
  'social-v2': { 0: (doc) => doc },
  'initial-prompts': { 0: (doc) => doc },
  'role-inject': { 0: (doc) => doc },
  archive: { 0: (doc) => doc },
  conversations: { 0: (doc) => doc },
  pool: { 0: (doc) => doc },
});

export class FutureSchemaError extends Error {
  // 记录文件名与版本号
  constructor(name, found, supported) {
    super(`${name} 的 schemaVersion=${found} 高于本程序支持的 ${supported}（被更新版本的桥接写过），已只读降级`);
    this.code = 'FUTURE_SCHEMA';
    this.found = found;
    this.supported = supported;
  }
}

/** 没写版本号当 0；不是正常整数就报错，调用方只读 */
export function schemaVersionOf(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 0;
  if (!Object.prototype.hasOwnProperty.call(doc, SCHEMA_KEY)) return 0;
  const v = doc[SCHEMA_KEY];
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`schemaVersion 非法：${JSON.stringify(v)}`);
  return v;
}

/**
 * 把文档迁移到当前版本
 * @returns {object} 迁移后的文档和版本信息
 * @throws {FutureSchemaError} 版本高于本程序支持
 */
export function migrateDocument(name, doc) {
  const current = SCHEMA_VERSIONS[name];
  if (current === undefined) throw new Error(`未登记的 schema：${name}`);
  const from = schemaVersionOf(doc);
  if (from > current) throw new FutureSchemaError(name, from, current);
  let next = doc;
  for (let v = from; v < current; v += 1) {
    const step = MIGRATIONS[name]?.[v];
    if (typeof step !== 'function') throw new Error(`${name} 缺少 v${v} → v${v + 1} 的迁移`);
    next = step(next);
  }
  if (next && typeof next === 'object' && !Array.isArray(next)) next[SCHEMA_KEY] = current;
  return { doc: next, from, to: current, migrated: from !== current };
}

/** 写盘前打上当前版本，原地修改并返回 */
export function stampSchema(name, doc) {
  const current = SCHEMA_VERSIONS[name];
  if (current === undefined) throw new Error(`未登记的 schema：${name}`);
  doc[SCHEMA_KEY] = current;
  return doc;
}
