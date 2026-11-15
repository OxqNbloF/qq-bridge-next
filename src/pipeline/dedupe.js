// 消息管线去重：键 (conv, message_id)，每会话 LRU（docs/architecture-refactor.md §3.2 阶段 2）
// 只管进程内；跨重启由 archive 自己的去重兜底

export function createDeduper({ max = 2000 } = {}) {
  const byConv = new Map();
  /** 第一次见返回 false 并记下；重复返回 true。没有 message_id 的不去重 */
  function seen(conv, messageId) {
    const id = String(messageId ?? '');
    if (!id) return false;
    let ids = byConv.get(conv);
    if (!ids) byConv.set(conv, ids = new Set());
    if (ids.has(id)) {
      ids.delete(id);
      ids.add(id);
      return true;
    }
    ids.add(id);
    if (ids.size > max) ids.delete(ids.values().next().value);
    return false;
  }
  return {
    seen,
    forget: (conv, messageId) => {
      if (messageId == null) return false;
      const ids = byConv.get(conv);
      if (!ids) return false;
      return ids.delete(String(messageId));
    },
  };
}
