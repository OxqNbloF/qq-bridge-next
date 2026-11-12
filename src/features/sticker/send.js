// 表情发送、备注与收藏
import { canonicalV2Key } from '../../policy/access.js';
import { findSticker, markStickerUsed, stickerForScope, applyStickerNote } from '../../sticker-lib.js';

// 创建表情发送函数，b 为桥接访问器
export function createStickerSender(b) {
  // 按 emoji_id/url/md5 发送一个收藏表情
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = b.captureSendGuard(key, { ai: true, explicitAllow: true });
    // 发前强制同步，确保新增可用、已删不发
    const synced = await b.syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? b.stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 表情单独成条，不能带文字或引用
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内安全下载，不能把 URL 交给网关重抓
    let image;
    try {
      image = await b.safeFetchBuffer(url, b.MAX_MEDIA_BYTES, { allowPorts: b.MEDIA_FETCH_ALLOW_PORTS });
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(b.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本共用会话发送链，保证先文字后表情
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    // 必须局部声明，否则严格模式 ReferenceError
    let sendChain = b.sendChainFor(key).then(async () => {
      try {
        // 发表情前随机停顿
        await b.sleep(b.randInt(800, 2000));
        assertSendAllowed();
        const res = await b.fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(b.cfg.snowluma?.accessToken ? { authorization: `Bearer ${b.cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    b.rememberSendChain(key, sendChain);
    const data = await sendResult;
    b.archiveOutgoing(key, `[表情:${entry.id}]`, data, {
      replyTo: replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === ''
        ? null : String(replyToMessageId).trim(),
      media: [{ kind: 'image', subType: 'sticker', emojiId: entry.id, summary: entry.desc || entry.localNote }],
    });
    // 更新本地使用统计
    const updated = markStickerUsed(b.stickerEntries, entry.id, 'sticker');
    b.stickerEntries = updated.entries;
    b.saveStickerStoreSafe();
    return { entry: stickerForScope(updated.entry, key), messageId: data?.message_id ?? null };
  }

  // 更新本地表情认知（含义/标签/用法）
  function applyStickerNoteV2(stickerId, note, tags, usage, currentKey = '') {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    // 备注归属写它的会话，防泄露到别的会话；控制台写的为全局
    if (currentKey) {
      const scope = canonicalV2Key(currentKey);
      // key 不合法时保留原归属，退回 global 会泄露
      if (scope) patch.noteScope = scope;
    }
    const updated = applyStickerNote(b.stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    b.stickerEntries = updated.entries;
    b.saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 收藏表情备注并同步本地 desc
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await b.syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? b.stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await b.bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(b.stickerEntries, entry.id, {});
    // 只改 desc，保留本地认知
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    b.stickerEntries = updated.entries;
    b.saveStickerStoreSafe();
    return b.stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天中的表情并写备注
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = b.captureSendGuard(key, { ai: true });
    const st = b.getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 先取图片字节转 base64；禁止把原始 url/file 交给 OneBot 下载
      const img = await b.fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await b.fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await b.bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(b.cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await b.bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        b.log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让新收藏立即可用
    const synced = await b.syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? b.stickerEntries, emojiId);
    return { emojiId, entry: stickerForScope(entry, key), remark: cleanRemark };
  }

  return { sendStickerV2, applyStickerNoteV2, setStickerRemarkV2, collectStickerV2 };
}
