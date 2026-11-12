// 登记本会话见过的转发媒体；只许下载登记过的，不信任请求体
import { canonicalV2Key } from '../policy/access.js';

// 创建转发媒体登记表
export function createForwardMediaRegistry() {
  const forwardMediaRefs = new Map();
  const FORWARD_MEDIA_TTL_MS = 10 * 60 * 1000;
  const MAX_FORWARD_MEDIA_REFS = 1000;

  /** 把媒体项归一成引用串；不合法返回 '' */
  function forwardMediaKey(item) {
    if (!item || typeof item !== 'object') return '';
    const kind = item.kind === 'face' ? 'face' : 'image';
    const values = ['file', 'url', 'faceId'].map((name) => (item[name] == null ? '' : String(item[name])));
    if (!values.some(Boolean)) return '';
    if (values.some((v) => v.length > 8192)) return '';
    return JSON.stringify([kind, ...values]);
  }

  /** 登记转发消息里的媒体（来源必须是 get_forward_msg 返回值） */
  function rememberForwardMedia(key, messages) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return;
    const now = Date.now();
    // 顺手清掉过期条目，防止无界增长
    for (const [owner, refs] of forwardMediaRefs) {
      for (const [ref, record] of refs) if (record.until <= now) refs.delete(ref);
      if (!refs.size) forwardMediaRefs.delete(owner);
    }
    const refs = forwardMediaRefs.get(canonical) ?? new Map();
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const item of message?.media ?? []) {
        const ref = forwardMediaKey(item);
        if (!ref) continue;
        const media = { kind: item.kind === 'face' ? 'face' : 'image' };
        for (const name of ['file', 'url', 'faceId']) if (item[name] != null) media[name] = String(item[name]);
        refs.set(ref, { media, until: now + FORWARD_MEDIA_TTL_MS });
      }
    }
    while (refs.size > MAX_FORWARD_MEDIA_REFS) refs.delete(refs.keys().next().value);
    forwardMediaRefs.set(canonical, refs);
  }

  return { forwardMediaRefs, forwardMediaKey, rememberForwardMedia, FORWARD_MEDIA_TTL_MS, MAX_FORWARD_MEDIA_REFS };
}
