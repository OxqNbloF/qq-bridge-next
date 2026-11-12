// 黑话库存在记忆池里（kind=slang）；旧 slang.json 首次启动时导入
import fs from 'node:fs';
import { loadSlang, normalizeSlangEntry, capSlangEntries, SLANG_STATUS, SLANG_MAX_ENTRIES } from '../../slang-learner.js';

const TO_POOL_STATUS = { [SLANG_STATUS.CANDIDATE]: 'candidate', [SLANG_STATUS.CONFIRMED]: 'active', [SLANG_STATUS.REJECTED]: 'rejected' };
const FROM_POOL_STATUS = { candidate: SLANG_STATUS.CANDIDATE, active: SLANG_STATUS.CONFIRMED, rejected: SLANG_STATUS.REJECTED };

/** 黑话词条转成记忆池条目，专用字段原样保留 */
export function slangEntryToPoolItem(entry) {
  const e = normalizeSlangEntry(entry);
  return {
    id: e.id,
    conv_id: e.scope, // 'global' 或会话 key（也可能是 invalid:…）
    kind: 'slang',
    content: e.content,
    status: TO_POOL_STATUS[e.status],
    // 只有带消息号的证据才算来源
    source_msg_ids: [...new Set(e.evidence.map((ev) => ev?.messageId ?? ev?.message_id).filter((id) => id != null).map(String))],
    mention_count: e.count,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    term: e.content.toLowerCase(),
    meaning: e.meaning,
    usage: e.usage,
    example: e.example,
    risk: e.risk,
    sources: e.sources,
    source: e.source,
    evidence: e.evidence,
    last_inference_count: e.lastInferenceCount,
  };
}

// 记忆池条目转回黑话词条
export function poolItemToSlangEntry(item) {
  return normalizeSlangEntry({
    id: item.id, content: item.content, meaning: item.meaning, usage: item.usage, example: item.example, risk: item.risk,
    sources: item.sources, status: FROM_POOL_STATUS[item.status], source: item.source, scope: item.conv_id,
    count: item.mention_count, evidence: item.evidence, lastInferenceCount: item.last_inference_count,
    createdAt: item.created_at, updatedAt: item.updated_at,
  });
}

/**
 * 创建落在记忆池上的黑话库存储
 * @param {object} o
 * @param {object} o.pool 记忆池，有 query 和 replaceKind
 * @param {string} o.legacyFile  旧的 state/slang.json
 * @param {(msg: string) => void} o.log
 */
export function createSlangPoolStore({ pool, legacyFile, log }) {
  /** 读黑话库；读不出就报错，调用方改成只读，绝不当成空库 */
  function loadSlangEntries() {
    const stored = pool.query({ kind: 'slang' });
    if (stored.length) return stored.map(poolItemToSlangEntry).filter((e) => e.content);
    // 池里还没黑话时导入旧文件
    const legacy = loadSlang(legacyFile, { onCorrupt: (message) => log(`⚠️ ${message}`) });
    if (!legacy.length) return [];
    pool.replaceKind('slang', legacy.map(slangEntryToPoolItem));
    try {
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
      log(`黑话库已并入记忆池：${legacy.length} 条；旧文件保留为 ${legacyFile}.migrated`);
    } catch (error) {
      // 改名失败不影响使用，下次启动不会再读旧文件
      log(`黑话库已并入记忆池：${legacy.length} 条；旧文件改名失败（${error?.message ?? error}），可手工删除`);
    }
    return legacy;
  }

  /** 删到不超过上限后写进文件，返回留下的和丢掉的 */
  function saveSlangEntries(entries, { max = SLANG_MAX_ENTRIES } = {}) {
    const capped = capSlangEntries((Array.isArray(entries) ? entries : []).map(normalizeSlangEntry).filter((e) => e.content), max);
    pool.replaceKind('slang', capped.entries.map(slangEntryToPoolItem));
    return capped;
  }

  return { loadSlangEntries, saveSlangEntries };
}
