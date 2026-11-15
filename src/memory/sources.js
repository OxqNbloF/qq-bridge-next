// 超过可追踪上限时标为来源不完整，不能截断后伪装成可靠归因。
export function boundedSources(ids) {
  if (!Array.isArray(ids)) return [];
  const sources = [...new Set(ids.map(String))];
  return sources.length <= 50 ? sources : [];
}

export function mergeSources(old, next) {
  return old?.length && next?.length ? boundedSources([...old, ...next]) : [];
}
