// 每个聊天的记忆搜索索引；从记忆池生成，坏了就改用内存排序
import fs from 'node:fs';
import path from 'node:path';
import { safeConvName } from '../store/views.js';

const RRF_K = 60;
const DECAY_DAYS = 30;

/** 取 node:sqlite 的 DatabaseSync；不可用返回 null */
export async function loadSqlite() {
  try { return (await import('node:sqlite')).DatabaseSync ?? null; } catch { return null; }
}

/** 把要搜的话拆成几个小词，方便查找 */
export function queryGrams(query) {
  const runs = String(query ?? '').toLowerCase().replace(/[​-‏﻿]/g, '').match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9]+/gu) ?? [];
  const tri = new Set();
  const bi = new Set();
  for (const run of runs) {
    const chars = [...run];
    if (chars.length === 2) bi.add(run);
    for (let i = 0; i + 3 <= chars.length && tri.size < 40; i++) tri.add(chars.slice(i, i + 3).join(''));
    // 长段也拆成两字一组，给模糊查找和内存排序留着用
    if (/[^a-z0-9]/.test(run)) for (let i = 0; i + 2 <= chars.length && bi.size < 40; i++) bi.add(chars.slice(i, i + 2).join(''));
  }
  return { tri: [...tri], bi: [...bi] };
}

// 把一条记忆的标题和内容拼成小写文字
const textOf = (it) => `${it.subject_uid ?? ''} ${it.content ?? ''}`.toLowerCase();
// 判断这条记忆还有效吗（没删、没过期）
const alive = (it, now) => it.status === 'active' && !(it.expire_at && Date.parse(it.expire_at) <= now);
// 算这条记忆有多重要：越重要越新分越高
const prior = (it, now) => (Number(it.importance) || 3) * Math.exp(-Math.max(0, now - (Date.parse(it.updated_at) || now)) / (DECAY_DAYS * 86400_000));

/** 不用数据库时按命中的词数排序 */
export function lexicalRank(items, grams) {
  const terms = [...grams.tri, ...grams.bi];
  return items.map((it) => { const text = textOf(it); return { id: it.id, hits: terms.filter((t) => text.includes(t)).length }; })
    .filter((r) => r.hits > 0).sort((a, b) => b.hits - a.hits).map((r) => r.id);
}

// 算两段文字有多像，用于去掉重复内容
function jaccard(a, b) {
  // 把文字拆成相邻两字一组，用来比相似度
  const grams = (s) => { const c = [...s]; return new Set(c.slice(0, -1).map((ch, i) => ch + c[i + 1])); };
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/** 把两种排序结果合并，再去掉很像的重复条目 */
export function fuse(items, relevantIds, { now = Date.now(), limit = 8 } = {}) {
  const live = items.filter((it) => alive(it, now));
  const byId = new Map(live.map((it) => [it.id, it]));
  const score = new Map();
  // 把一路排序结果按名次加分，前面名次加得多
  const add = (ids, weight) => ids.forEach((id, rank) => { if (byId.has(id)) score.set(id, (score.get(id) ?? 0) + weight / (RRF_K + rank + 1)); });
  add(relevantIds, 2); // 有词面命中的优先
  add([...live].sort((a, b) => prior(b, now) - prior(a, now)).slice(0, 20).map((it) => it.id), 1);
  const picked = [];
  for (const id of [...score.keys()].sort((a, b) => score.get(b) - score.get(a))) {
    const it = byId.get(id);
    if (picked.some((p) => jaccard(p.content, it.content) > 0.8)) continue;
    picked.push(it);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * 创建记忆检索索引
 * @param {object} o
 * @param {string} o.dir            state/index
 * @param {Function|null} o.DatabaseSync 为空时只用内存
 * @param {(msg: string) => void} [o.log]
 */
export function createMemoryIndex({ dir, DatabaseSync, log = () => {} }) {
  const dbs = new Map(); // 每个聊天的数据库连接，空表示改用内存排序
  const failedAt = new Map(); // convId -> 上次失败时间，过 RETRY_MS 再试
  const built = new Set(); // 已按池重建过且文件还在的会话
  const RETRY_MS = 10 * 60 * 1000;
  // 算出这个聊天的索引文件放在哪
  const fileOf = (convId) => path.join(dir, `${safeConvName(convId)}.sqlite`);

  // 关闭并忘掉一个会话的索引连接
  function forget(convId) {
    try { dbs.get(convId)?.close(); } catch {}
    dbs.delete(convId);
    built.delete(convId);
  }

  // 打开会话索引，打不开就返回 null，改用内存排序
  function open(convId) {
    if (dbs.has(convId)) {
      const cached = dbs.get(convId);
      if (cached && !fs.existsSync(fileOf(convId))) forget(convId); // 运行中被删：重开并重建
      else if (!cached && Date.now() - (failedAt.get(convId) ?? 0) >= RETRY_MS) forget(convId);
      else return cached;
    }
    let db = null;
    if (DatabaseSync) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        db = new DatabaseSync(fileOf(convId));
        db.exec("create virtual table if not exists items_fts using fts5(id unindexed, body, tokenize='trigram')");
      } catch (error) {
        log(`[index] ${convId} 索引不可用，改用内存检索：${error?.message ?? error}`);
        try { db?.close(); } catch {}
        db = null;
        failedAt.set(convId, Date.now());
        // 打不开的索引文件直接删，过重试间隔再建
        for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(fileOf(convId) + suffix); } catch {} }
      }
    }
    dbs.set(convId, db);
    return db;
  }

  /** 用池里的条目把索引整个重建一遍，返回有没有成功 */
  function rebuild(convId, items) {
    const db = open(convId);
    if (!db) return false;
    try {
      db.exec('begin');
      db.exec('delete from items_fts');
      const insert = db.prepare('insert into items_fts(id, body) values (?, ?)');
      for (const it of items) insert.run(String(it.id), textOf(it));
      db.exec('commit');
      built.add(convId);
      return true;
    } catch (error) {
      try { db.exec('rollback'); } catch {}
      log(`[index] ${convId} 重建失败，改用内存检索：${error?.message ?? error}`);
      dropFile(convId); // 坏文件删掉，过重试间隔再建
      dbs.set(convId, null);
      failedAt.set(convId, Date.now());
      return false;
    }
  }

  /**
   * 检索该会话条目；items 必须已按 conv_id 过滤
   * @returns {object} 结果里有 items、used_memory_ids 和 via
   */
  function search(convId, items, query, { limit = 8, now = Date.now() } = {}) {
    const grams = queryGrams(query);
    let relevant = null;
    const db = open(convId);
    if (db) {
      try {
        const ids = [];
        if (grams.tri.length) {
          const match = grams.tri.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
          for (const row of db.prepare('select id from items_fts where items_fts match ? order by bm25(items_fts) limit 20').all(match)) ids.push(row.id);
        }
        // 两个字的小词查不到，就换成模糊查找补在后面
        const likeHits = new Map();
        const like = db.prepare("select id from items_fts where body like ? escape '\\' limit 50");
        for (const term of grams.bi.slice(0, 12)) {
          for (const row of like.all(`%${term.replace(/[\\%_]/g, '\\$&')}%`)) likeHits.set(row.id, (likeHits.get(row.id) ?? 0) + 1);
        }
        for (const id of [...likeHits.keys()].sort((a, b) => likeHits.get(b) - likeHits.get(a))) if (!ids.includes(id)) ids.push(id);
        relevant = ids;
      } catch (error) {
        log(`[index] ${convId} 查询失败，改用内存检索：${error?.message ?? error}`);
        dropFile(convId);
        dbs.set(convId, null);
        failedAt.set(convId, Date.now());
      }
    }
    const via = relevant ? 'fts' : 'memory';
    const picked = fuse(items, relevant ?? lexicalRank(items, grams), { now, limit });
    return { items: picked, used_memory_ids: picked.map((it) => it.id), via };
  }

  /** 会话删除时连索引文件一起删 */
  function dropFile(convId) {
    forget(convId);
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(fileOf(convId) + suffix); } catch {} }
  }
  // 删除索引并清除失败记录
  function drop(convId) {
    dropFile(convId);
    failedAt.delete(convId);
  }
  /** 索引是否可用；没建、被删、重建失败都返回 false */
  function isBuilt(convId) {
    open(convId);
    return built.has(convId);
  }

  // 关闭所有索引连接
  function close() {
    for (const db of dbs.values()) { try { db?.close(); } catch {} }
    dbs.clear();
    built.clear();
  }

  return { rebuild, search, drop, close, isBuilt };
}
