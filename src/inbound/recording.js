// 入站记录：媒体引用缓存与受 memory flag 约束的底账写入。
export function createInboundRecording(b) {
  function cacheIncomingMedia(envelope, key) {
    const seqRef = envelope.raw.message_seq != null ? String(envelope.raw.message_seq) : '';
    const refs = [...new Set([envelope.id, seqRef].filter(Boolean))];
    if (!refs.length || !envelope.media.length) return;
    let mediaByRef = b.messageMediaStore.get(key);
    if (!mediaByRef) {
      mediaByRef = new Map();
      b.messageMediaStore.set(key, mediaByRef);
    }
    for (const ref of refs) mediaByRef.set(ref, envelope.media);
    while (mediaByRef.size > b.MAX_MEDIA_STORE_PER_KEY) {
      const oldestKey = mediaByRef.keys().next().value;
      if (oldestKey === undefined) break;
      mediaByRef.delete(oldestKey);
    }
  }

  // false 表示已归档的重复消息，不再执行后续副作用。
  function recordIncoming(envelope, flags) {
    if (!flags.memory) return true;
    const archived = b.memoryAPI.record(envelope);
    if (archived?.duplicate) return false;
    if (archived?.written) envelope.seq = archived.seq;
    return true;
  }

  return { cacheIncomingMedia, recordIncoming };
}
