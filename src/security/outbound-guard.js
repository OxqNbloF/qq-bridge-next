// 出站守卫：Markdown 转纯文本、自然短句切分、敏感信息拦截与按会话滑动窗口限流
import { isChatAllowed, resolveChatMode } from './access.js';

export function mdToPlain(input) {
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

export function splitMessages(rawMessages, { maxChars = 500, maxBurst = 4 } = {}) {
  const list = Array.isArray(rawMessages)
    ? rawMessages
    : (typeof rawMessages === 'string' ? [rawMessages] : []);
  const out = [];
  for (const item of list) {
    const clean = mdToPlain(item);
    if (!clean) continue;
    for (let i = 0; i < clean.length; i += maxChars) {
      out.push(clean.slice(i, i + maxChars));
      if (out.length >= maxBurst) return out;
    }
  }
  return out;
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SENSITIVE_PATH_RE = /(?:\/(?:etc\/shadow|etc\/passwd)|config\.json\b|console\.token\b|x-(?:console|agent)-token\b|QQ_SESSION_SOCK\b)/i;
const CREDENTIAL_PREFIX_RE = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;

export function detectSensitive(text, secretValues = []) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const secret of secretValues) {
    if (secret && s.includes(secret)) return '命中运行时受保护密钥/令牌';
  }
  if (PRIVATE_KEY_RE.test(s)) return '命中私钥头';
  if (SENSITIVE_PATH_RE.test(s)) return '命中受保护本机路径或凭证字段';
  if (CREDENTIAL_PREFIX_RE.test(s)) return '命中疑似 API 密钥特征';
  return null;
}

export function createOutboundGuard({ getConfig, getSecrets = () => [] }) {
  const sendTimestamps = new Map(); // convKey -> number[]

  function auditAndPrepare(convKey, rawMessages) {
    const cfg = getConfig();
    if (!isChatAllowed(cfg, convKey)) {
      return { ok: false, code: 'CHAT_NOT_ALLOWED', error: `会话 ${convKey} 不在白名单允许范围内` };
    }
    const mode = resolveChatMode(cfg, convKey);
    if (mode === 'off' || mode === 'listen') {
      return { ok: false, code: 'MODE_READONLY', error: `当前模式 (${mode}) 不允许对外发言` };
    }

    const maxBurst = Number(cfg?.security?.maxBurstMessages) || 4;
    const messages = splitMessages(rawMessages, { maxChars: 500, maxBurst });
    if (!messages.length) {
      return { ok: false, code: 'EMPTY_MESSAGE', error: '发送内容不能为空' };
    }

    if (cfg?.security?.blockSensitiveOutbound !== false) {
      const secrets = getSecrets();
      for (const msg of messages) {
        const hit = detectSensitive(msg, secrets);
        if (hit) {
          return { ok: false, code: 'SENSITIVE_BLOCKED', error: `出站安全拦截：${hit}` };
        }
      }
    }

    const limitPerMin = Number(cfg?.security?.rateLimitPerMinute) || 20;
    const now = Date.now();
    const recent = (sendTimestamps.get(convKey) ?? []).filter((ts) => now - ts < 60000);
    if (recent.length + messages.length > limitPerMin) {
      sendTimestamps.set(convKey, recent);
      return { ok: false, code: 'RATE_LIMITED', error: `触发每分钟发送频率上限（${limitPerMin} 条/分）` };
    }
    for (let i = 0; i < messages.length; i += 1) recent.push(now);
    sendTimestamps.set(convKey, recent);

    return { ok: true, messages };
  }

  return { auditAndPrepare };
}
