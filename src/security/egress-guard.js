// 出站审查守卫：Markdown 纯文本化、分段、敏感信息拦截与每房间滑动窗口限流
import { isRoomPermitted, resolveRoomMode } from './perimeter.js';

export function stripMarkdown(input) {
  let s = String(input ?? '');
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body) => body.trim());
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => (alt ? `[图片:${alt}]` : '[图片]'));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  return s.replace(/\r\n/g, '\n').trim();
}

export function chunkReplies(rawReplies, { maxChars = 500, maxBurst = 4 } = {}) {
  const list = Array.isArray(rawReplies)
    ? rawReplies
    : (typeof rawReplies === 'string' ? [rawReplies] : []);
  const out = [];
  for (const item of list) {
    const clean = stripMarkdown(item);
    if (!clean) continue;
    for (let i = 0; i < clean.length; i += maxChars) {
      out.push(clean.slice(i, i + maxChars));
      if (out.length >= maxBurst) return out;
    }
  }
  return out;
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const RESTRICTED_PATH_RE = /(?:\/(?:etc\/shadow|etc\/passwd)|config\.json\b|control\.secret\b|x-control-secret\b|RELAY_ROOM_SOCK\b)/i;
const CREDENTIAL_TOKEN_RE = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;

export function scanSensitive(text, secretValues = []) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const secret of secretValues) {
    if (secret && s.includes(secret)) return '命中运行时受保护密钥';
  }
  if (PRIVATE_KEY_RE.test(s)) return '命中私钥头';
  if (RESTRICTED_PATH_RE.test(s)) return '命中受保护路径或凭据字段';
  if (CREDENTIAL_TOKEN_RE.test(s)) return '命中疑似 API 密钥特征';
  return null;
}

export function createEgressGuard({ getConfig, getSecrets = () => [] }) {
  const sendTimestamps = new Map(); // roomId -> number[]

  function inspectAndFormat(roomId, rawReplies) {
    const cfg = getConfig();
    if (!isRoomPermitted(cfg, roomId)) {
      return { ok: false, code: 'ROOM_NOT_PERMITTED', error: `房间 ${roomId} 不在白名单允许范围内` };
    }
    const mode = resolveRoomMode(cfg, roomId);
    if (mode === 'muted' || mode === 'observer') {
      return { ok: false, code: 'MODE_READONLY', error: `当前模式 (${mode}) 不允许对外发言` };
    }

    const maxBurst = Number(cfg?.guard?.maxBurst) || 4;
    const messages = chunkReplies(rawReplies, { maxChars: 500, maxBurst });
    if (!messages.length) return { ok: false, code: 'EMPTY_MESSAGE', error: '发送内容不能为空' };

    if (cfg?.guard?.blockSensitive !== false) {
      const secrets = getSecrets();
      for (const msg of messages) {
        const hit = scanSensitive(msg, secrets);
        if (hit) return { ok: false, code: 'SENSITIVE_BLOCKED', error: `出站安全拦截：${hit}` };
      }
    }

    const cap = Number(cfg?.guard?.maxPerMinute) || 20;
    const now = Date.now();
    const recent = (sendTimestamps.get(roomId) ?? []).filter((ts) => now - ts < 60000);
    if (recent.length + messages.length > cap) {
      sendTimestamps.set(roomId, recent);
      return { ok: false, code: 'RATE_LIMITED', error: `触发每分钟发送上限（${cap} 条/分）` };
    }
    for (let i = 0; i < messages.length; i += 1) recent.push(now);
    sendTimestamps.set(roomId, recent);

    return { ok: true, messages };
  }

  return { inspectAndFormat };
}
