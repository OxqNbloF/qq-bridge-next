// 合并转发消息束展开：提取 bundleId 并扁平化多层嵌套内容

export function extractBundleIds(segments) {
  if (!Array.isArray(segments)) return [];
  const ids = [];
  for (const seg of segments) {
    if (seg?.type === 'forward' && seg.data?.id) ids.push(String(seg.data.id));
  }
  return [...new Set(ids)];
}

function summarizeNodeContent(content, depth, maxDepth, mediaOut) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const seg of content) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      parts.push(String(seg.data?.text ?? ''));
    } else if (seg.type === 'image') {
      const url = String(seg.data?.url || seg.data?.file || '');
      if (url) mediaOut.push({ type: 'image', url });
      parts.push('[图片]');
    } else if (seg.type === 'forward') {
      if (depth < maxDepth && Array.isArray(seg.data?.content)) {
        const sub = flattenBundleNodes(seg.data.content, { depth: depth + 1, maxDepth });
        parts.push(`[嵌套转发: ${sub.lines.join(' / ')}]`);
        mediaOut.push(...sub.media);
      } else {
        parts.push(`[合并转发#${seg.data?.id ?? ''}]`);
      }
    } else if (seg.type) {
      parts.push(`[${seg.type}]`);
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function flattenBundleNodes(nodes, { depth = 0, maxDepth = 3, maxNodes = 40 } = {}) {
  if (!Array.isArray(nodes) || depth > maxDepth) return { lines: [], media: [], truncated: false };
  const lines = [];
  const media = [];
  let truncated = false;

  for (const node of nodes) {
    if (lines.length >= maxNodes) { truncated = true; break; }
    const sender = String(node?.data?.name || node?.sender?.nickname || node?.data?.uin || '成员').trim();
    const rawContent = node?.data?.content ?? node?.content ?? node?.message ?? '';
    const text = summarizeNodeContent(rawContent, depth, maxDepth, media);
    if (text) lines.push(`${sender}: ${text.slice(0, 300)}`);
  }
  return { lines, media, truncated };
}
