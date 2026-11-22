// 记忆池：所有记忆条目都存在 state/pool/items.jsonl
// 文件读坏了就报错，不当成空池，免得把原来的记忆写没
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText } from './fs-atomic.js';
import { migrateDocument, stampSchema } from './schema.js';

// 打开记忆池文件，返回读写它的方法
export function createMemoryPool({ file }) {
  let items = null; // 第一次用到才读；读失败就一直报错，不会当成空池
  let dirReady = false;

  // 把文件里的记忆读出来，只读一次
  function load() {
    if (items) return items;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') { items = []; return items; }
      throw new Error(`记忆池读取失败（${error?.code || 'unknown'}）：${error?.message ?? error}`);
    }
    const lines = text.replace(/^\uFEFF/, '').split('\n').filter((l) => l.trim());
    const parsed = lines.map((line, i) => {
      try {
        const v = JSON.parse(line);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('不是对象');
        return v;
      } catch (error) { throw new Error(`记忆池第 ${i + 1} 行损坏：${error?.message ?? error}`); }
    });
    // 第一行可能只写版本号；没有这行时第一行也是记忆，不能丢
    const hasHeader = parsed.length > 0 && 'schemaVersion' in parsed[0] && !('id' in parsed[0]);
    if (hasHeader) migrateDocument('pool', parsed[0]); // 文件比本程序新就报错只读
    const body = hasHeader ? parsed.slice(1) : parsed;
    const bad = body.findIndex((it) => typeof it.id !== 'string' || !it.id || typeof it.kind !== 'string' || !it.kind);
    if (bad >= 0) throw new Error(`记忆池第 ${bad + 2} 行缺少 id / kind`);
    items = body;
    return items;
  }

  /** 按 kind/kinds/convId 过滤条目；默认返回副本，内部只读路径可传 clone: false 零拷贝 */
  function query({ kind, kinds, convId, clone = true } = {}) {
    const kindSet = Array.isArray(kinds) ? new Set(kinds) : null;
    const matched = load().filter((it) => {
      if (kind && it.kind !== kind) return false;
      if (kindSet && !kindSet.has(it.kind)) return false;
      if (convId && it.conv_id !== convId) return false;
      return true;
    });
    return clone ? structuredClone(matched) : matched;
  }

  /** 用新的条目替换某一类，其它类不动；存不上就报错 */
  function replaceKind(kind, next) {
    replaceKinds([kind], next.map((it) => ({ ...it, kind })));
  }

  /** 一次写完替换好几类，新条目要自己带类别 */
  function replaceKinds(kinds, next) {
    update((all) => [...all.filter((it) => !kinds.includes(it.kind)), ...next]);
  }

  /** 统一写入口：传入函数算出新列表，一次写完 */
  function update(fn) {
    const merged = fn(load());
    if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirReady = true; }
    atomicWriteText(file, `${[stampSchema('pool', {}), ...merged].map((it) => JSON.stringify(it)).join('\n')}\n`);
    items = merged;
  }

  return { query, replaceKind, replaceKinds, update };
}
