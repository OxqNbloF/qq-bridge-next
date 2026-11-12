// 把收发的消息都记进消息档案；出错只写日志，不影响收发

export function createArchiveWiring(b) {
  /** 记账失败不能影响收发，只写日志 */
  function archiveSafely(op, fn) {
    if (!b.messageArchive) return;
    try { fn(b.messageArchive); }
    catch (error) { b.log(`[archive] ${op}失败：${error?.message ?? error}`); }
  }

  /** 收到消息按顺序记下来：先入档，再进聊天记录，再处理 */
  function archiveIncoming(key, event, { textContent, plainContent, mediaList }) {
    archiveSafely('入站落盘', (archive) => {
      const segments = Array.isArray(event?.message) ? event.message : [];
      const replySeg = segments.find((seg) => seg?.type === 'reply');
      const selfId = String(event?.self_id ?? '');
      const atBot = !!selfId && segments.some((seg) => seg?.type === 'at' && String(seg.data?.qq ?? '') === selfId);
      const t = Number(event?.time);
      archive.append({
        conv_id: key,
        msg_id: event?.message_id ?? event?.msg_id ?? '',
        at: Number.isFinite(t) && t > 0 ? t * 1000 : undefined,
        from: 'user',
        user_id: event?.user_id,
        nick: event?.sender?.card || event?.sender?.nickname || '',
        text: textContent,
        plain: plainContent,
        reply_to: replySeg?.data?.id ?? null,
        at_bot: atBot,
        media: mediaList,
      });
    });
  }

  /** 机器人自己发出的消息也进底账（from: 'bot'），发送成功之后才写。 */
  // 表情、语音、拍一拍也这样记；拍一拍没有消息号，自动生成一个
  function archiveOutgoing(key, message, result, { replyTo = null, media = [] } = {}) {
    archiveSafely('出站落盘', (archive) => {
      const messageId = result && typeof result === 'object' ? result.message_id : result;
      archive.append({
        conv_id: key,
        msg_id: messageId === undefined || messageId === null ? '' : `bot-${messageId}`,
        from: 'bot',
        user_id: '',
        text: String(message ?? ''),
        reply_to: replyTo,
        media,
      });
    });
  }

  return { archiveSafely, archiveIncoming, archiveOutgoing };
}
