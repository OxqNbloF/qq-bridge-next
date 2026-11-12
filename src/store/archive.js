// 所有消息的完整记录，按聊天和日期分文件，同一条只写一次
// 只有删隐私那步会改旧文件；图片只存说明，不存网址和内容
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalV2Key } from '../policy/access.js';

export const ARCHIVE_LINE_VERSION = 1;
const SHARD_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const MEDIA_FIELDS = ['kind', 'file', 'subType', 'summary', 'emojiId', 'emojiPackageId', 'faceId', 'sizeBytes', 'width', 'height'];

/** group:123 转成 group_123；非规范 key 返回 null */
export function convDirName(convId) {
  const canonical = canonicalV2Key(convId);
  return canonical ? canonical.replace(':', '_') : null;
}

/** 本地日期 YYYY-MM-DD，分片按本地时区切日 */
export function localDay(ms) {
  const d = new Date(ms);
  // 小于两位的数字前面补个 0
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 带本地时区偏移的 ISO 时间 */
export function localIso(ms) {
  const d = new Date(ms);
  // 时区偏移的数字也补成两位
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

// 只保留媒体元数据白名单字段，截断超长值
export function pickMediaMeta(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => m && typeof m === 'object').map((m) => {
    const out = {};
    for (const field of MEDIA_FIELDS) {
      const value = m[field];
      if (value === undefined || value === null || value === '') continue;
      out[field] = typeof value === 'number' ? value : String(value).slice(0, 300);
    }
    return out;
  });
}

// 算消息内容的 sha256
function contentHash(record) {
  const basis = JSON.stringify([record.from, record.user_id, record.text, record.media]);
  return `sha256:${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

// 从分片文件名里读出日期和第几卷
function parseShard(name) {
  const m = SHARD_RE.exec(name);
  return m ? { name, day: m[1], part: m[2] ? Number(m[2]) : 0 } : null;
}

// 分片按日期、卷号排序
function compareShards(a, b) {
  return a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1);
}

/** 读出分片里能用的行；坏行只计数，不报错 */
function readShardLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { records: [], bad: 0 }; }
  const records = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && Number.isSafeInteger(rec.seq)) records.push(rec);
      else bad += 1;
    } catch { bad += 1; }
  }
  return { records, bad };
}

/**
 * 创建消息底账（就是把消息一条条追加进文件）
 * @param {object} opts
 * @param {string} opts.dir 存放的根目录
 * @param {() => number} [opts.now]
 * @param {(...a:any[]) => void} [opts.log]
 * @param {number} [opts.maxShardBytes] 单卷最大多少字节
 * @param {number} [opts.idWindow] 每个会话记多少个已见编号
 */
export function createMessageArchive({
  dir, now = () => Date.now(), log = () => {}, maxShardBytes = 64 * 1024 * 1024, idWindow = 5000,
} = {}) {
  if (!dir) throw new Error('createMessageArchive: 缺少 dir');
  /** 每个会话的目录、最后序号和已见编号 */
  const convs = new Map();

  // 列出会话目录下的分片，已排序
  function shardsOf(dirPath) {
    let names = [];
    try { names = fs.readdirSync(dirPath); } catch { return []; }
    return names.map(parseShard).filter(Boolean).sort(compareShards);
  }

  // 记入去重窗口，超出 idWindow 淘汰最老的
  function rememberId(conv, msgId) {
    if (!msgId || conv.ids.has(msgId)) return;
    conv.ids.add(msgId);
    conv.idOrder.push(msgId);
    while (conv.idOrder.length > idWindow) conv.ids.delete(conv.idOrder.shift());
  }

  /** 首次访问会话时从最新分片恢复 lastSeq 与去重窗口 */
  function open(convId) {
    const canonical = canonicalV2Key(convId);
    if (!canonical) throw new Error(`archive: 非法会话 key ${JSON.stringify(convId)}`);
    let conv = convs.get(canonical);
    if (conv) return conv;
    const dirPath = path.join(dir, convDirName(canonical));
    conv = { id: canonical, dirPath, lastSeq: 0, ids: new Set(), idOrder: [], current: null };
    const shards = shardsOf(dirPath);
    const recovered = [];
    let badTotal = 0;
    for (let i = shards.length - 1; i >= 0 && recovered.length < idWindow; i -= 1) {
      const { records, bad } = readShardLines(path.join(dirPath, shards[i].name));
      badTotal += bad;
      recovered.unshift(...records);
      if (i === shards.length - 1) {
        const file = path.join(dirPath, shards[i].name);
        let bytes = 0;
        let needsNewline = false;
        try {
          bytes = fs.statSync(file).size;
          if (bytes > 0) {
            const fd = fs.openSync(file, 'r');
            try {
              const last = Buffer.alloc(1);
              fs.readSync(fd, last, 0, 1, bytes - 1);
              needsNewline = last[0] !== 0x0a;
            } finally { fs.closeSync(fd); }
          }
        } catch {}
        conv.current = { file, day: shards[i].day, part: shards[i].part, bytes, needsNewline };
      }
    }
    for (const rec of recovered) {
      if (rec.seq > conv.lastSeq) conv.lastSeq = rec.seq;
      if (rec.type === 'message') rememberId(conv, String(rec.msg_id ?? ''));
    }
    if (badTotal) log(`[archive] ${canonical}: 跳过 ${badTotal} 行无法解析的记录（可能是崩溃时的半行）`);
    convs.set(canonical, conv);
    return conv;
  }

  // 选写入的分卷：换日或写满就换卷
  function targetShard(conv, atMs, lineBytes) {
    const day = localDay(atMs);
    let cur = conv.current;
    if (!cur || cur.day !== day) {
      // 换日时同日已有分卷就接着写最后一卷
      const sameDay = shardsOf(conv.dirPath).filter((s) => s.day === day);
      const last = sameDay[sameDay.length - 1];
      const part = last ? last.part : 0;
      const file = path.join(conv.dirPath, `${day}${part ? `.${part}` : ''}.jsonl`);
      let bytes = 0;
      try { bytes = fs.statSync(file).size; } catch {}
      cur = { file, day, part, bytes, needsNewline: false };
    }
    if (cur.bytes > 0 && cur.bytes + lineBytes > maxShardBytes) {
      const part = cur.part + 1;
      cur = { file: path.join(conv.dirPath, `${day}.${part}.jsonl`), day, part, bytes: 0, needsNewline: false };
    }
    conv.current = cur;
    return cur;
  }

  // 向分卷追加一行，必要时先补换行
  function writeLine(conv, record, atMs) {
    fs.mkdirSync(conv.dirPath, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(record)}\n`;
    const shard = targetShard(conv, atMs, Buffer.byteLength(line));
    const payload = shard.needsNewline ? `\n${line}` : line;
    fs.appendFileSync(shard.file, payload, { encoding: 'utf8', mode: 0o600 });
    shard.bytes += Buffer.byteLength(payload);
    shard.needsNewline = false;
  }

  /**
   * 追加一条消息，同一个消息编号只写一次
   * @returns {object} 有没有写进去、写在第几号
   */
  function append(input) {
    const conv = open(input?.conv_id);
    const msgId = String(input.msg_id ?? '').trim();
    if (msgId && conv.ids.has(msgId)) return { written: false, duplicate: true, seq: 0 };
    const atMs = Number.isFinite(input.at) ? input.at : now();
    const record = {
      v: ARCHIVE_LINE_VERSION,
      type: 'message',
      conv_id: conv.id,
      seq: conv.lastSeq + 1,
      msg_id: msgId || `local-${crypto.randomUUID()}`,
      ts: localIso(atMs),
      at: atMs,
      from: input.from === 'bot' ? 'bot' : 'user',
      user_id: input.user_id === undefined || input.user_id === null ? '' : String(input.user_id),
      nick: String(input.nick ?? ''),
      text: String(input.text ?? ''),
      plain: input.plain === undefined ? undefined : String(input.plain),
      reply_to: input.reply_to === undefined || input.reply_to === null || input.reply_to === '' ? null : String(input.reply_to),
      at_bot: input.at_bot === true,
      media: pickMediaMeta(input.media),
    };
    if (record.plain === undefined || record.plain === record.text) delete record.plain;
    record.hash = contentHash(record);
    writeLine(conv, record, atMs);
    conv.lastSeq = record.seq;
    rememberId(conv, record.msg_id);
    return { written: true, seq: record.seq };
  }

  /** 撤回：追加事件，不改写原行 */
  function markRecalled(convId, msgId, { operatorId = '', at } = {}) {
    const conv = open(convId);
    const atMs = Number.isFinite(at) ? at : now();
    const record = {
      v: ARCHIVE_LINE_VERSION, type: 'recall', conv_id: conv.id, seq: conv.lastSeq + 1,
      msg_id: String(msgId ?? ''), at: atMs, operator_id: String(operatorId ?? ''),
    };
    writeLine(conv, record, atMs);
    conv.lastSeq = record.seq;
    return { written: true, seq: record.seq };
  }

  /**
   * 按序号读消息，撤回的会标成 recalled:true
   * @param {string} convId 会话编号
   * @param {object} [opts] 起始序号、结束序号、条数等
   */
  function range(convId, { afterSeq = 0, toSeq = Number.POSITIVE_INFINITY, limit = Number.POSITIVE_INFINITY, includeEvents = false } = {}) {
    const conv = open(convId);
    const out = [];
    const recalled = new Set();
    for (const shard of shardsOf(conv.dirPath)) {
      for (const rec of readShardLines(path.join(conv.dirPath, shard.name)).records) {
        if (rec.type === 'recall') recalled.add(String(rec.msg_id));
        if (rec.seq <= afterSeq || rec.seq > toSeq) continue;
        if (rec.type !== 'message' && !includeEvents) continue;
        if (out.length < limit) out.push(rec);
      }
    }
    return out.map((rec) => (rec.type === 'message' && recalled.has(String(rec.msg_id)) ? { ...rec, recalled: true } : rec));
  }

  /** 读游标之后的消息，供记忆压缩 */
  function sinceCursor(convId, cursor, limit) {
    return range(convId, { afterSeq: Number(cursor) || 0, limit });
  }

  // 会话当前最大 seq
  function lastSeq(convId) {
    return open(convId).lastSeq;
  }

  /**
   * 隐私删除：清空该消息正文/昵称/媒体，保留 seq 与 msg_id
   * @returns {number} 被改写的行数
   */
  function redact(convId, msgId) {
    const conv = open(convId);
    const target = String(msgId ?? '');
    let changed = 0;
    for (const shard of shardsOf(conv.dirPath)) {
      const file = path.join(conv.dirPath, shard.name);
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      let hit = false;
      const lines = raw.split('\n').map((line) => {
        if (!line.trim()) return line;
        let rec;
        try { rec = JSON.parse(line); } catch { return line; }
        if (rec?.type !== 'message' || String(rec.msg_id) !== target || rec.redacted === true) return line;
        hit = true;
        changed += 1;
        return JSON.stringify({ ...rec, nick: '', text: '', plain: undefined, media: [], hash: null, redacted: true });
      });
      if (!hit) continue;
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      if (conv.current?.file === file) conv.current.bytes = fs.statSync(file).size;
    }
    return changed;
  }

  /**
      * 删除过期、而且已经被记忆压缩读过的旧文件
   * @returns {string[]} 被删除的分卷路径
   */
  function prune({ olderThanDays, cursorFor = () => 0 } = {}) {
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) return [];
    const cutoff = localDay(now() - olderThanDays * 86400000);
    const removed = [];
    let dirs = [];
    try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    for (const name of dirs) {
      const convId = name.replace('_', ':');
      if (!canonicalV2Key(convId)) continue;
      const cursor = Number(cursorFor(canonicalV2Key(convId))) || 0;
      const dirPath = path.join(dir, name);
      const shards = shardsOf(dirPath);
      // 每个会话最新一卷永不删，否则 seq 重置会让新消息被当成已处理
      for (const shard of shards.slice(0, -1)) {
        if (shard.day >= cutoff) continue;
        const file = path.join(dirPath, shard.name);
        const { records } = readShardLines(file);
        const maxSeq = records.reduce((m, r) => Math.max(m, r.seq), 0);
        if (maxSeq > cursor) continue; // 还没被压缩消费的内容不能删
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
    }
    if (removed.length) log(`[archive] 保留期清理删除 ${removed.length} 个分卷`);
    return removed;
  }

  return { dir, append, markRecalled, range, sinceCursor, lastSeq, redact, prune };
}
