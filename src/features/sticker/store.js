// 本地表情库的保存、同步与读取
import { saveStickerStore, mergeStickerLibrary, formatStickerList, findSticker } from '../../sticker-lib.js';

// 创建表情库存储
export function createStickerStore(b) {
  // 表情功能是否开启
  function stickerEnabled() {
    return b.cfg.socialV2?.sticker?.enabled !== false;
  }

  // 可写时才保存表情库
  function saveStickerStoreSafe() {
    if (!b.stickerStoreWritable) return; // 读失败时绝不回写，免得把损坏当成空库
    try { saveStickerStore(b.STICKER_FILE, b.stickerEntries); } catch (error) { b.log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 OneBot 拉收藏表情并合并进本地库；force 忽略 TTL，失败返回 null
  async function syncStickerLibrary(force = false) {
    if (b.cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(b.cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && b.stickerSyncedAt && now - b.stickerSyncedAt < ttl) {
      return { entries: b.stickerEntries, syncedAt: b.stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(b.cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        response = await b.bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败就改用 HTTP 重试同一个 action
        b.log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await b.onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才合并，不能用空数组清空本地库
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      b.stickerEntries = mergeStickerLibrary(b.stickerEntries, fetched, { complete: fetched.length < count });
      b.stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      b.log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${b.stickerEntries.length} 条，via ${via}）`);
      return { entries: b.stickerEntries, syncedAt: b.stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      b.log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? b.stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? b.stickerEntries, stickerId);
    if (!entry) {
      // 本地找不到就强制刷新一次再找
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? b.stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  return { stickerEnabled, saveStickerStoreSafe, syncStickerLibrary, listStickersForV2, getStickerImageData };
}
