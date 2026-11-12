// Token 账本：按会话×回合记 usage，读取时折算金额；
// 同一步重复上报只留一条，来了就写进文件
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PRICE_TABLE,
  ZERO_BUCKETS,
  addBuckets,
  costOfBuckets,
  isPeakAt,
  normalizeUsage,
  priceUsage,
  ratesAt,
  totalTokensOf
} from './model-prices.js';

/** 记录编号：同一回合同一步骤只留最新一条 */
function sampleKeyOf(sessionId, turn, step, retry) {
  return `${sessionId}|${turn}|${step}|${retry}`;
}

/** 走势图桶宽阶梯，导出供离线 fixture 共用 */
export const BUCKET_LADDER_MS = [
  5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000,
  60 * 60 * 1000, 2 * 60 * 60 * 1000, 3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000
];

/** 不超过 maxBuckets 时选最细的桶 */
export function pickBucketMs(windowMs, maxBuckets) {
  for (const candidate of BUCKET_LADDER_MS) {
    if (windowMs / candidate <= maxBuckets) return candidate;
  }
  return BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1];
}

/** 取最后一条带用量的助手消息记录 */
export function usageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i];
    if (chunk && typeof chunk === 'object' && chunk.usage !== undefined) return chunk.usage;
  }
  return undefined;
}

/** 取会话事件携带的原始 provider usage */
export function usageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return usageFromStream(event.data?.stream);
}

/**
 * 建立 token 账本
 * @param {object} options
 * @param {string} options.file 存到哪个文件
 * @param {Function} [options.log] 记日志的函数
 * @param {object} [options.priceTable]   价目表
 * @param {Function} [options.resolveKey] 会话号转会话名
 * @param {number} [options.maxLines]     行数上限，超出压缩重写
 * @param {() => number} [options.now]
 */
export function createTokenLedger({
  file,
  log = () => {},
  priceTable = DEFAULT_PRICE_TABLE,
  resolveKey,
  maxLines = 20000,
  now = () => Date.now()
} = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createTokenLedger: file is required');

  /** 会话 -> 最新的起始累计值 */
  const baselines = new Map();
  /** 记录编号 -> 一条记录 */
  const samples = new Map();
  /** sessionId -> 重试轴，区分同步骤的多次请求 */
  const retryAxis = new Map();
  /** sessionId -> 最近的会话 key */
  const sessionKeys = new Map();
  /** 会话 -> 被删记录的总和 */
  const evicted = new Map();
  let evictedDirty = false;
  /** sessionId -> 最近活动时间 */
  const sessionSeen = new Map();
  /** 已写进文件的行数，用来决定何时压缩 */
  let journalLines = 0;
  let lastIngestAt = 0;
  let lastCompactedAt = 0;
  let droppedLines = 0;

  // 查会话号对应哪个聊天，查不到就用上次的
  function keyOf(sessionId) {
    let key;
    try {
      key = resolveKey?.(sessionId);
    } catch {
      key = undefined;
    }
    if (key) {
      sessionKeys.set(sessionId, key);
      return key;
    }
    return sessionKeys.get(sessionId);
  }

  // ── 载入 ──
  function applyRecord(record, { fromDisk }) {
    if (!record || typeof record !== 'object') return false;
    const sid = record.sid;
    if (typeof sid !== 'string' || !sid) return false;
    if (record.key) sessionKeys.set(sid, record.key);
    const seq = Number.isFinite(Number(record.seq)) ? Number(record.seq) : -1;
    const t = Number.isFinite(Number(record.t)) ? Number(record.t) : 0;
    const buckets = normalizeUsage(record.b);

    // 被删掉的记录：只留总数和花的钱
    if (record.k === 'evict') {
      const prevEvicted = evicted.get(sid);
      if (prevEvicted && prevEvicted.dropped >= (Number(record.dropped) || 0)) return false;
      evicted.set(sid, {
        sessionId: sid,
        key: record.key,
        buckets,
        cost: Number(record.cost) || 0,
        byTier: {
          peak: Number(record.peak) || 0,
          off: Number(record.off) || 0
        },
        estimated: record.estimated === true,
        dropped: Number(record.dropped) || 0,
        maxSeq: Number.isFinite(Number(record.maxSeq)) ? Number(record.maxSeq) : -1
      });
      if (t > (sessionSeen.get(sid) ?? 0)) sessionSeen.set(sid, t);
      return true;
    }

    if (record.k === 'base') {
      const prev = baselines.get(sid);
      if (prev && prev.seq > seq) return false; // 旧的起始值不能盖掉新的
      baselines.set(sid, {
        sessionId: sid,
        key: record.key,
        seq,
        t,
        model: record.model,
        provider: record.provider,
        buckets
      });
      if (t > (sessionSeen.get(sid) ?? 0)) sessionSeen.set(sid, t);
      return true;
    }

    if (record.k === 'turn') {
      const turn = Number(record.turn);
      const step = Number(record.step);
      const retry = Number.isFinite(Number(record.retry)) ? Number(record.retry) : 0;
      if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
      const sk = sampleKeyOf(sid, turn, step, retry);
      const prev = samples.get(sk);
      // 只有序号更新才覆盖，序号相同当重复
      if (prev && seq >= 0 && prev.seq >= seq) return false;
      samples.set(sk, {
        sessionId: sid,
        key: record.key,
        seq,
        t,
        turn,
        step,
        retry,
        model: record.model,
        provider: record.provider,
        buckets
      });
      const axis = retryAxis.get(sid);
      if (!axis || axis.seq <= seq) retryAxis.set(sid, { turn, step, retry, seq });
      if (t > (sessionSeen.get(sid) ?? 0)) sessionSeen.set(sid, t);
      return true;
    }
    return false;
  }

  // 从 JSONL 载入账本
  function load() {
    baselines.clear();
    samples.clear();
    retryAxis.clear();
    sessionKeys.clear();
    sessionSeen.clear();
    journalLines = 0;
    droppedLines = 0;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // 首次运行：文件还不存在
    }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      journalLines += 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        droppedLines += 1; // 进程中断留下的半行：跳过
        continue;
      }
      try {
        applyRecord(record, { fromDisk: true });
      } catch (error) {
        droppedLines += 1;
        log('token 账本：丢弃无法应用的行', error?.message ?? error);
      }
    }
  }

  // ── 存到硬盘 ──
  function appendLine(record) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      journalLines += 1;
      return true;
    } catch (error) {
      log('token 账本：写入失败', error?.message ?? error);
      return false;
    }
  }

  /** 把内存里的数据整个写回文件，丢掉旧记录 */
  function compact() {
    const out = [];
    for (const base of baselines.values()) {
      out.push({
        k: 'base', t: base.t, sid: base.sessionId, key: base.key, seq: base.seq,
        model: base.model, provider: base.provider, b: base.buckets
      });
    }
    for (const s of samples.values()) {
      out.push({
        k: 'turn', t: s.t, sid: s.sessionId, key: s.key, seq: s.seq,
        turn: s.turn, step: s.step, retry: s.retry,
        model: s.model, provider: s.provider, b: s.buckets
      });
    }
    for (const e of evicted.values()) {
      out.push({
        k: 'evict', t: sessionSeen.get(e.sessionId) ?? 0, sid: e.sessionId, key: e.key,
        b: e.buckets, cost: e.cost, peak: e.byTier.peak, off: e.byTier.off,
        estimated: e.estimated, dropped: e.dropped, maxSeq: Number(e.maxSeq) >= 0 ? Number(e.maxSeq) : -1
      });
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
      fs.writeFileSync(tmp, out.map((r) => `${JSON.stringify(r)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      journalLines = out.length;
      evictedDirty = false;
      lastCompactedAt = now();
      return true;
    } catch (error) {
      log('token 账本：压缩失败', error?.message ?? error);
      return false;
    }
  }

  /** 删最旧的记录控制体积；只丢明细不丢总数 */
  function evictOldestSamples() {
    const overflow = samples.size - maxLines;
    if (overflow <= 0) return 0;
    const ordered = [...samples.entries()].sort((a, b) => a[1].t - b[1].t);
    for (let i = 0; i < overflow; i += 1) {
      const [sampleId, sample] = ordered[i];
      samples.delete(sampleId);
      const acc = evicted.get(sample.sessionId) ?? {
        sessionId: sample.sessionId,
        key: sample.key,
        buckets: { ...ZERO_BUCKETS },
        cost: 0,
        byTier: { peak: 0, off: 0 },
        estimated: false,
        dropped: 0,
        // 删掉的最大序号，用来判断是否已经算过
        maxSeq: -1
      };
      acc.buckets = addBuckets(acc.buckets, sample.buckets);
      const sampleSeq = Number(sample.seq);
      if (Number.isFinite(sampleSeq) && sampleSeq >= 0) {
        acc.maxSeq = Math.max(Number(acc.maxSeq) >= 0 ? Number(acc.maxSeq) : -1, sampleSeq);
      }
      const p = priceUsage(sample.buckets, { model: sample.model, at: sample.t || now(), table: priceTable });
      acc.cost += p.cost.total;
      acc.byTier[p.rates.tier] += p.cost.total;
      acc.estimated ||= p.rates.estimated;
      acc.dropped += 1;
      if (sample.key) acc.key = sample.key;
      evicted.set(sample.sessionId, acc);
      evictedDirty = true;
    }
    return overflow;
  }

  /** 删掉的记录是否已算进新的起始值，防重复收钱 */
  function evictionCovered(entry) {
    if (!entry) return false;
    const base = baselines.get(entry.sessionId);
    const maxSeq = Number(entry.maxSeq);
    if (!base || !Number.isFinite(maxSeq) || maxSeq < 0) return false;
    return Number(base.seq) >= maxSeq;
  }

  // 超过上限时删掉旧记录，再整个重写
  function maybeCompact() {
    if (journalLines <= maxLines && samples.size <= maxLines && !evictedDirty) return;
    const dropped = evictOldestSamples();
    if (dropped > 0) log(`token 账本：逐轮明细超过 ${maxLines} 条，已淘汰最旧的 ${dropped} 条（累计总量不受影响）`);
    compact();
  }

  // ── 摄入 ──

  /**
   * 摄入一条会话事件
   * @param {object} args
   * @param {string} args.sessionId
   * @param {object} args.event       SessionEvent
   * @param {'live'|'snapshot'} [args.origin] 来源，仅统计用
   * @param {number} [args.at]        事件时间
   * @param {string} [args.model]     实际模型
   * @param {string} [args.provider]
   * @returns {boolean} 是否产生新记录
   */
  function ingestEvent({ sessionId, event, origin = 'live', at, model, provider } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !event || typeof event !== 'object') return false;
    // 时间优先取事件自带的 time，它决定峰谷档位
    const t = Number.isFinite(Number(at)) ? Number(at)
      : (Number.isFinite(Number(event.time)) ? Number(event.time) : now());
    const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : -1;
    const eventModel = model ?? event.data?.model ?? event.data?.usage?.model;
    const eventProvider = provider ?? event.data?.provider;

    if (event.type === 'llm/retry-started') {
      const turn = Number(event.data?.turn);
      const step = Number(event.data?.step);
      if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
      const retry = Number.isFinite(Number(event.data?.retry)) ? Number(event.data.retry) : 1;
      const axis = retryAxis.get(sessionId);
      if (axis && axis.seq > seq) return false;
      retryAxis.set(sessionId, { turn, step, retry, seq });
      return false; // 轴本身不入账
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false;
    const raw = usageOfEvent(event);
    if (!raw) return false;
    const turn = Number(event.data?.turn);
    const step = Number(event.data?.step);
    if (!Number.isFinite(turn) || !Number.isFinite(step)) return false;
    const axis = retryAxis.get(sessionId);
    const retry = axis && axis.turn === turn && axis.step === step ? axis.retry : 0;
    const buckets = normalizeUsage(raw);
    if (totalTokensOf(buckets) === 0) return false;

    const key = keyOf(sessionId);
    const sk = sampleKeyOf(sessionId, turn, step, retry);
    const prev = samples.get(sk);
    if (prev && seq >= 0 && prev.seq >= seq) return false;

    const record = {
      k: 'turn', t, sid: sessionId, key, seq,
      turn, step, retry,
      model: eventModel ?? prev?.model,
      provider: eventProvider ?? prev?.provider,
      b: buckets
    };
    samples.set(sk, {
      sessionId, key, seq, t, turn, step, retry,
      model: record.model, provider: record.provider, buckets
    });
    if (t > (sessionSeen.get(sessionId) ?? 0)) sessionSeen.set(sessionId, t);
    lastIngestAt = now();
    appendLine(record);
    maybeCompact();
    return true;
  }

  /** 记下快照里的起始值；总数=起始+之后的记录 */
  function ingestBaseline({ sessionId, projection, at, model, provider } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !projection) return false;
    const values = projection.values ?? projection;
    const tokenUsage = values?.tokenUsage;
    if (!tokenUsage) return false;
    const seq = Number.isFinite(Number(projection.asOfSeq)) ? Number(projection.asOfSeq) : -1;
    const t = Number.isFinite(Number(at)) ? Number(at) : now();
    const buckets = normalizeUsage(tokenUsage);
    const prev = baselines.get(sessionId);
    if (prev && prev.seq > seq) return false;
    const key = keyOf(sessionId);
    const same = prev && prev.seq === seq
      && prev.buckets.cacheMiss === buckets.cacheMiss
      && prev.buckets.cacheHit === buckets.cacheHit
      && prev.buckets.cacheWrite === buckets.cacheWrite
      && prev.buckets.output === buckets.output;
    baselines.set(sessionId, { sessionId, key, seq, t, model, provider, buckets });
    if (t > (sessionSeen.get(sessionId) ?? 0)) sessionSeen.set(sessionId, t);
    // 内容和序号都没变的重复记录不写文件
    if (same) return false;
    lastIngestAt = now();
    appendLine({
      k: 'base', t, sid: sessionId, key, seq,
      model, provider, b: buckets
    });
    // 起始值也要算进压缩判断
    maybeCompact();
    return true;
  }

  /** 摄入快照的全部历史记录 */
  function ingestSnapshotRecords({ sessionId, records, at } = {}) {
    if (!Array.isArray(records)) return 0;
    let n = 0;
    for (const entry of records) {
      const event = entry?.type === 'event' ? entry.event : entry;
      if (!event || typeof event !== 'object') continue;
      if (ingestEvent({ sessionId, event, origin: 'snapshot', at })) n += 1;
    }
    return n;
  }

  // ── 读取 ──

  /** 按会话取起始值加之后记录的累计用量 */
  /** 一次扫完所有记录，只算序号比起始值大的 */
  function buildIndex() {
    const index = new Map();
    for (const s of samples.values()) {
      let entry = index.get(s.sessionId);
      if (!entry) {
        entry = {
          liveBuckets: { ...ZERO_BUCKETS },
          liveCost: 0,
          liveByTier: { peak: 0, off: 0 },
          allCost: 0,
          allByTier: { peak: 0, off: 0 },
          estimated: false,
          turns: new Map(),
          models: new Set()
        };
        index.set(s.sessionId, entry);
      }
      const base = baselines.get(s.sessionId);
      const isLive = !base || s.seq > base.seq;
      const p = priceUsage(s.buckets, { model: s.model, at: s.t || now(), table: priceTable });
      entry.estimated ||= p.rates.estimated;
      entry.allCost += p.cost.total;
      entry.allByTier[p.rates.tier] += p.cost.total;
      if (isLive) {
        entry.liveBuckets = addBuckets(entry.liveBuckets, s.buckets);
        entry.liveCost += p.cost.total;
        entry.liveByTier[p.rates.tier] += p.cost.total;
      }
      let row = entry.turns.get(s.turn);
      if (!row) {
        row = {
          sessionId: s.sessionId,
          key: s.key,
          turn: s.turn,
          steps: 0,
          attempts: 0,
          startedAt: s.t,
          endedAt: s.t,
          model: s.model,
          provider: s.provider,
          buckets: { ...ZERO_BUCKETS },
          cost: 0,
          tier: null
        };
        entry.turns.set(s.turn, row);
      }
      row.buckets = addBuckets(row.buckets, s.buckets);
      row.steps += 1;
      row.attempts += s.retry > 0 ? 1 : 0;
      if (s.t < row.startedAt) row.startedAt = s.t;
      if (s.t > row.endedAt) row.endedAt = s.t;
      if (s.model) { row.model = s.model; entry.models.add(s.model); }
      if (s.provider) row.provider = s.provider;
      row.cost += p.cost.total;
      row.tier = row.tier === null || row.tier === p.rates.tier ? p.rates.tier : 'mixed';
    }
    return index;
  }

  /** 合成会话视图 */
  function sessionView(key, sessionIds, index) {
    const view = {
      key,
      sessionIds,
      sessions: sessionIds.length,
      buckets: { ...ZERO_BUCKETS },
      cost: 0,
      unattributedCost: 0,
      attributedCost: 0,
      byTier: { peak: 0, off: 0 },
      turns: 0,
      steps: 0,
      estimated: false,
      lastAt: 0,
      firstAt: 0,
      models: []
    };
    const models = new Set();
    for (const sid of sessionIds) {
      const base = baselines.get(sid);
      const entry = index.get(sid) ?? null;
      const rawGone = evicted.get(sid) ?? null;
      const gone = evictionCovered(rawGone) ? null : rawGone;
      const liveBuckets = entry?.liveBuckets ?? { ...ZERO_BUCKETS };
      const cumulative = addBuckets(base?.buckets ?? ZERO_BUCKETS, gone?.buckets ?? ZERO_BUCKETS);
      const total = addBuckets(cumulative, liveBuckets);
      view.buckets = addBuckets(view.buckets, total);

      let cost = (entry?.liveCost ?? 0) + (gone?.cost ?? 0);
      view.byTier.peak += (entry?.liveByTier.peak ?? 0) + (gone?.byTier.peak ?? 0);
      view.byTier.off += (entry?.liveByTier.off ?? 0) + (gone?.byTier.off ?? 0);
      view.estimated ||= (entry?.estimated ?? false) || (gone?.estimated ?? false);
      if (base) {
        const p = priceUsage(base.buckets, { model: base.model, at: base.t || now(), table: priceTable });
        cost += p.cost.total;
        view.byTier[p.rates.tier] += p.cost.total;
        view.estimated ||= p.rates.estimated;
      }
      view.cost += cost;
      if (entry) {
        for (const model of entry.models) models.add(model);
        for (const row of entry.turns.values()) {
          view.steps += row.steps;
          if (!view.firstAt || row.startedAt < view.firstAt) view.firstAt = row.startedAt;
          if (row.endedAt > view.lastAt) view.lastAt = row.endedAt;
        }
        view.turns += entry.turns.size;
      }
      // 可拆到回合的花费，差额是只剩累计的历史
      const attributed = entry?.allCost ?? 0;
      view.attributedCost += attributed;
      view.unattributedCost += Math.max(0, cost - attributed);
    }
    view.models = [...models];
    for (const sid of sessionIds) {
      const t = sessionSeen.get(sid);
      if (t && t > view.lastAt) view.lastAt = t;
    }
    return view;
  }

  /** 某会话逐轮明细（新的在前） */
  function turnsOf(sessionIds, index) {
    const rows = [];
    for (const sid of sessionIds) {
      const entry = index.get(sid);
      if (entry) rows.push(...entry.turns.values());
    }
    rows.sort((a, b) => b.turn - a.turn || b.endedAt - a.endedAt);
    return rows;
  }

  /** 账本中出现过的全部 sessionId */
  function allSessionIds() {
    const ids = new Set([...baselines.keys(), ...sessionSeen.keys(), ...evicted.keys()]);
    for (const s of samples.values()) ids.add(s.sessionId);
    return ids;
  }

  /** 汇总：全局 + 每个会话 */
  function summary({ limit = 200 } = {}) {
    const index = buildIndex();
    const byKey = new Map();
    for (const sid of allSessionIds()) {
      const key = keyOf(sid) ?? (baselines.get(sid)?.key) ?? null;
      const bucketKey = key ?? `未归属:${sid.slice(0, 8)}`;
      if (!byKey.has(bucketKey)) byKey.set(bucketKey, []);
      byKey.get(bucketKey).push(sid);
    }
    const conversations = [];
    for (const [key, sids] of byKey) conversations.push(sessionView(key, sids, index));
    conversations.sort((a, b) => b.cost - a.cost || totalTokensOf(b.buckets) - totalTokensOf(a.buckets));

    const totals = {
      buckets: { ...ZERO_BUCKETS },
      cost: 0,
      attributedCost: 0,
      unattributedCost: 0,
      byTier: { peak: 0, off: 0 },
      turns: 0,
      steps: 0,
      conversations: conversations.length,
      estimated: false
    };
    for (const c of conversations) {
      totals.buckets = addBuckets(totals.buckets, c.buckets);
      totals.cost += c.cost;
      totals.attributedCost += c.attributedCost;
      totals.unattributedCost += c.unattributedCost;
      totals.byTier.peak += c.byTier.peak;
      totals.byTier.off += c.byTier.off;
      totals.turns += c.turns;
      totals.steps += c.steps;
      totals.estimated ||= c.estimated;
    }
    const totalTok = totalTokensOf(totals.buckets);
    const inputTok = totals.buckets.cacheMiss + totals.buckets.cacheHit + totals.buckets.cacheWrite;
    return {
      ok: true,
      generatedAt: now(),
      priceVersion: priceTable.version,
      currency: priceTable.currency,
      symbol: priceTable.symbol,
      nowTier: ratesAt(undefined, now(), priceTable),
      priceTable: {
        version: priceTable.version,
        currency: priceTable.currency,
        symbol: priceTable.symbol,
        unit: priceTable.unit,
        peakMultiplier: priceTable.peakMultiplier,
        peakWindows: priceTable.peakWindows,
        peakWeekdays: priceTable.peakWeekdays,
        holidayCount: (priceTable.holidays ?? []).length,
        models: Object.fromEntries(Object.entries(priceTable.models).map(([name, m]) => [name, { label: m.label, off: m.off }]))
      },
      totals: {
        ...totals,
        totalTokens: totalTok,
        inputTokens: inputTok,
        cacheHitRate: inputTok > 0 ? totals.buckets.cacheHit / inputTok : 0,
        avgCostPerTurn: totals.turns > 0 ? totals.cost / totals.turns : 0,
        avgCostPerStep: totals.steps > 0 ? totals.cost / totals.steps : 0
      },
      conversations: conversations.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
    };
  }

  /** 单会话明细：汇总 + 逐轮 */
  function conversation(key, { turnLimit = 200 } = {}) {
    if (typeof key !== 'string' || !key) return null;
    const sids = [];
    for (const sid of allSessionIds()) {
      if (keyOf(sid) === key) sids.push(sid);
    }
    if (!sids.length) return null;
    const index = buildIndex();
    const view = sessionView(key, sids, index);
    const rows = turnsOf(sids, index);
    return {
      ok: true,
      generatedAt: now(),
      currency: priceTable.currency,
      symbol: priceTable.symbol,
      ...view,
      turnLimit,
      turns: rows.slice(0, Math.max(1, Math.min(1000, Number(turnLimit) || 200)))
    };
  }

  /** 按时间分桶的走势数据：单遍扫描、空桶补零 */
  function series({ hours = 24, maxBuckets = 48, at } = {}) {
    const endAt = Number.isFinite(Number(at)) ? Number(at) : now();
    const windowHours = Math.min(24 * 90, Math.max(1, Number(hours) || 24));
    const windowMs = windowHours * 60 * 60 * 1000;
    const bucketMs = pickBucketMs(windowMs, Math.max(6, Math.min(120, Number(maxBuckets) || 48)));
    // 桶边界对齐到 bucketMs 整数倍
    const end = Math.floor(endAt / bucketMs) * bucketMs + bucketMs;
    const start = end - Math.ceil(windowMs / bucketMs) * bucketMs;
    const count = Math.round((end - start) / bucketMs);

    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const t = start + i * bucketMs;
      rows.push({
        t,
        cost: 0,
        tokens: 0,
        cacheMiss: 0,
        cacheHit: 0,
        cacheWrite: 0,
        output: 0,
        turns: 0,
        steps: 0,
        tier: null,
        keys: new Set()
      });
    }
    const totals = { cost: 0, tokens: 0, turns: 0, steps: 0 };
    let estimated = false;
    let countedSamples = 0;
    // 逐桶轮次去重，键为 sessionId|turn
    const turnSeen = new Set();
    const rowTurnSeen = rows.map(() => new Set());
    // 总额 = 删掉的 + 起始的 + 还没算过的
    let ledgerCost = 0;
    let ledgerBuckets = { ...ZERO_BUCKETS };
    for (const e of evicted.values()) {
      if (evictionCovered(e)) continue; // 已经算过的不再算，免得重复收钱
      ledgerCost += Number(e.cost) || 0;
      ledgerBuckets = addBuckets(ledgerBuckets, e.buckets);
    }
    for (const base of baselines.values()) {
      // 起始值整体按快照那一刻算钱
      ledgerCost += priceUsage(base.buckets, { model: base.model, at: base.t || now(), table: priceTable }).cost.total;
      ledgerBuckets = addBuckets(ledgerBuckets, base.buckets);
    }
    for (const s of samples.values()) {
      // 每条记录只算一次钱
      const p = priceUsage(s.buckets, { model: s.model, at: s.t || endAt, table: priceTable });
      const tokens = totalTokensOf(s.buckets);
      const base = baselines.get(s.sessionId);
      if (!base || s.seq > base.seq) {
        ledgerCost += p.cost.total;
        ledgerBuckets = addBuckets(ledgerBuckets, s.buckets);
      }
      if (s.t < start || s.t >= end) continue;
      const idx = Math.min(count - 1, Math.max(0, Math.floor((s.t - start) / bucketMs)));
      const row = rows[idx];
      row.cost += p.cost.total;
      row.tokens += tokens;
      row.cacheMiss += s.buckets.cacheMiss;
      row.cacheHit += s.buckets.cacheHit;
      row.cacheWrite += s.buckets.cacheWrite;
      row.output += s.buckets.output;
      row.steps += 1;
      row.tier = row.tier === null || row.tier === p.rates.tier ? p.rates.tier : 'mixed';
      row.keys.add(keyOf(s.sessionId) ?? s.key ?? null);
      const turnId = `${s.sessionId}|${s.turn}`;
      if (!rowTurnSeen[idx].has(turnId)) {
        rowTurnSeen[idx].add(turnId);
        row.turns += 1;
      }
      // 跨桶的同一回合只算一次
      if (!turnSeen.has(turnId)) {
        turnSeen.add(turnId);
        totals.turns += 1;
      }
      totals.cost += p.cost.total;
      totals.tokens += tokens;
      totals.steps += 1;
      estimated ||= p.rates.estimated;
      countedSamples += 1;
    }
    for (const row of rows) {
      // 空桶按该时刻真实峰谷标档位
      if (row.tier === null) row.tier = isPeakAt(row.t, priceTable) ? 'peak' : 'off';
      row.keys = [...row.keys].filter(Boolean);
    }

    let busiest = null;
    for (const row of rows) {
      if (row.cost <= 0) continue;
      if (!busiest || row.cost > busiest.cost) busiest = row;
    }
    // 时间轴之外的部分，用同一次遍历累出的总额
    const ledgerTokens = totalTokensOf(ledgerBuckets);
    return {
      ok: true,
      generatedAt: endAt,
      currency: priceTable.currency,
      symbol: priceTable.symbol,
      hours: windowHours,
      bucketMs,
      from: start,
      to: end,
      buckets: rows.map(({ keys, ...rest }) => ({ ...rest, keys })),
      totals,
      busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
      estimated,
      countedSamples,
      // 时间轴之外的部分，控制台单独说明
      offChartCost: Math.max(0, ledgerCost - totals.cost),
      offChartTokens: Math.max(0, ledgerTokens - totals.tokens)
    };
  }

  /** 最近几条记录，按时间倒序 */
  function recent(limit = 50) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const all = [...samples.values()].sort((a, b) => b.t - a.t);
    const out = [];
    for (const s of all.slice(0, n)) {
      const p = priceUsage(s.buckets, { model: s.model, at: s.t || now(), table: priceTable });
      out.push({
        time: s.t,
        key: keyOf(s.sessionId) ?? s.key ?? null,
        sessionId: s.sessionId,
        turn: s.turn,
        step: s.step,
        retry: s.retry,
        model: s.model ?? null,
        tokens: totalTokensOf(s.buckets),
        ...s.buckets,
        cost: p.cost.total,
        tier: p.rates.tier,
        estimated: p.rates.estimated
      });
    }
    return out;
  }

  // 账本内部统计
  function stats() {
    return {
      file,
      journalLines,
      maxLines,
      droppedLines,
      sessions: new Set([...baselines.keys(), ...sessionSeen.keys()]).size,
      baselines: baselines.size,
      samples: samples.size,
      lastIngestAt,
      lastCompactedAt,
      priceVersion: priceTable.version
    };
  }

  /** 清空账本 */
  function reset() {
    baselines.clear();
    samples.clear();
    retryAxis.clear();
    sessionKeys.clear();
    sessionSeen.clear();
    // 删掉记录的总和也要清掉，否则旧总额会复活
    evicted.clear();
    evictedDirty = false;
    droppedLines = 0;
    lastCompactedAt = 0;
    journalLines = 0;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log('token 账本：重置失败', error?.message ?? error);
    }
    lastIngestAt = 0;
  }

  load();

  return {
    ingestEvent,
    ingestBaseline,
    ingestSnapshotRecords,
    summary,
    conversation,
    series,
    recent,
    stats,
    reset,
    compact,
    hasSession: (sid) => baselines.has(sid) || sessionSeen.has(sid),
    file
  };
}
