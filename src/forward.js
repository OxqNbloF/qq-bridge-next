// 处理 QQ 的合并转发（就是把多条聊天记录打包成一条）
// 先找出里面的转发编号，再整理成 AI 容易读的样子
// 只做整理不联网；编号是否合法由调用方自己去查

import { truncateText } from './md-to-plain.js';

// 检查转发编号，只留安全字符，太长就不要
export function sanitizeForwardId(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  // 只允许普通字母数字和几个符号，空格和控制字符一律不要
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

// 从一条转发消息的数据里取出转发编号
export function forwardIdFromData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}

// 从一堆消息段里找出所有转发编号
export function extractForwardIds(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
    const id = forwardIdFromData(seg.data);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// 把一段消息变成人能看的一句话
function segmentText(seg) {
  if (typeof seg === 'string') return seg;
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text': return String(d.text ?? '');
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': return '[引用]';
    case 'forward': return '[转发]';
    case 'json': return '[卡片消息]';
    default: return `[${seg.type ?? '未知'}]`;
  }
}

// 把 [CQ:...] 代码换成 [媒体] 这样的占位
function sanitizeCqString(s) {
  // 把 [CQ:...] 代码换成 [媒体]，免得原样给 AI 看
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, '[媒体]');
}

// 把消息内容转成纯文字
function contentToText(content) {
  if (typeof content === 'string') return sanitizeCqString(content);
  if (Array.isArray(content)) return sanitizeCqString(content.map(segmentText).join('').trim());
  if (content && typeof content === 'object') {
    // 单独一段消息也可能是完整的一条，格式和下面一样
    if (content.type) return sanitizeCqString(segmentText(content).trim());
    if (typeof content.text === 'string') return sanitizeCqString(content.text);
    if (Array.isArray(content.content)) return sanitizeCqString(content.content.map(segmentText).join('').trim());
  }
  return '';
}

// 取出一条转发消息里的正文
export function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  // 一条转发消息的常见格式：data 里有名字、号码、时间和内容
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const text = contentToText(topContent) || contentToText(dataContent);
  return text;
}

// 取出这条转发是谁发的（名字）
function senderName(node) {
  if (!node || typeof node !== 'object') return '';
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  // 用专门的截断函数，免得把表情切成半个乱码
  if (sender && typeof sender === 'object') {
    const name = sender.nickname || sender.card || sender.user_id || '';
    if (name) return truncateText(String(name), 100);
  }
  if (typeof sender === 'string' && sender) return truncateText(String(sender), 100);
  const name = data.name || data.nickname || data.card || data.uin || data.user_id || node.name || node.nickname || '';
  return truncateText(String(name ?? ''), 100);
}

// 取出转发发送人的 QQ 号
function senderUserId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  const uid = sender && typeof sender === 'object' ? sender.user_id : data.uin ?? data.user_id ?? node.uin ?? node.user_id;
  return uid != null ? String(uid) : null;
}

// 取出这条转发的发送时间
function nodeTime(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const t = node.time ?? data.time;
  return t != null ? Number(t) : null;
}

// 取出这条转发的消息编号
function nodeMessageId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const id = node.message_id ?? node.messageId ?? data.message_id ?? data.id ?? null;
  return id != null ? String(id) : null;
}

// 取出这条转发的顺序号
function nodeMessageSeq(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const seq = node.message_seq ?? node.messageSeq ?? data.message_seq ?? data.seq ?? null;
  return seq != null ? String(seq) : null;
}

// 取出这条转发的原始内容
function nodeContent(node) {
  if (!node || typeof node !== 'object') return [];
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const content = Array.isArray(topContent) ? topContent : Array.isArray(dataContent) ? dataContent : null;
  if (content) return content;
  // 和上面一样：单独一段里也可能有图片或转发
  for (const candidate of [topContent, dataContent]) {
    if (candidate && typeof candidate === 'object') {
      if (candidate.type) return [candidate];
      if (Array.isArray(candidate.content)) return candidate.content;
    }
  }
  // 字符串内容没有可提取的媒体/嵌套转发
  return [];
}

// 从一段消息里找出图片或表情
function segmentMedia(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const d = seg.data ?? {};
  if (seg.type === 'image') {
    const file = String(d.file ?? d.file_id ?? d.filename ?? '');
    const url = String(d.url ?? d.src ?? '');
    if (file || url) return { kind: 'image', file: file || undefined, url: url || undefined };
  }
  if (seg.type === 'face') {
    const faceId = String(d.id ?? d.face_id ?? '');
    if (faceId) return { kind: 'face', faceId };
  }
  return null;
}

// 从一段消息里找出里面套着的转发编号
function segmentNestedForwardId(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'forward') return null;
  return forwardIdFromData(seg.data);
}

// 从一段消息内容（数组）中提取图片/表情与嵌套转发 id。
function collectSegmentMeta(content) {
  const media = [];
  const nestedForwardIds = [];
  if (!Array.isArray(content)) return { media, nestedForwardIds };
  for (const seg of content) {
    const m = segmentMedia(seg);
    if (m) media.push(m);
    const nested = segmentNestedForwardId(seg);
    if (nested && !nestedForwardIds.includes(nested)) nestedForwardIds.push(nested);
  }
  return { media, nestedForwardIds };
}

// 把转发内容整理成 AI 好读的样子
export function formatForwardResponse(data, options = {}) {
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 50));
  const maxCharsPerMessage = Math.max(1, Math.min(2000, Number(options.maxCharsPerMessage) || 500));
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const total = raw.length;
  const truncatedByCount = total > maxMessages;
  let textTruncated = false;
  const messages = raw.slice(0, maxMessages).map((node, index) => {
    const fullText = nodeText(node);
    // 截断时别把表情切成半个，不然会显示成乱码
    let cut = maxCharsPerMessage;
    const cutCode = fullText.charCodeAt(cut - 1);
    if (cutCode >= 0xd800 && cutCode <= 0xdbff) cut -= 1;
    // 就算只留一个字，也要留完整的一个，不能是半个表情
    if (cut === 0) {
      const first = fullText.charCodeAt(0);
      const second = fullText.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
    }
    const text = fullText.slice(0, cut);
    if (fullText.length > maxCharsPerMessage) textTruncated = true;
    const content = nodeContent(node);
    const meta = collectSegmentMeta(content);
    return {
      index: index + 1,
      sender: senderName(node),
      userId: senderUserId(node),
      time: nodeTime(node),
      messageId: nodeMessageId(node),
      messageSeq: nodeMessageSeq(node),
      text,
      media: meta.media,
      nestedForwardIds: meta.nestedForwardIds
    };
  });
  return {
    total,
    truncated: truncatedByCount || textTruncated,
    textTruncated,
    messages
  };
}
