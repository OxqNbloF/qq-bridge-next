// 出站审计：静默标记、发送工具识别、令牌登记与脱敏

// 静默标记：模型输出它时不发 QQ；宁可误拦，不可泄露
export const SILENT_MARKER = '[SILENT]';
// 文本是否为静默标记
export function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// 回合内调过这些工具就跳过自动转发，防重复发送
export const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
// 工具名是否为发送类工具
export function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 按 12 字符窗口匹配令牌，防拆成多条消息绕过整串检查
export const TOKEN_FRAGMENT_WIDTH = 12;

/** 文本是否含任一 token 的任意 12 字符窗口 */
export function hasTokenFragment(text, tokens) {
  const value = String(text ?? '');
  if (!value) return false;
  for (const token of tokens) {
    if (!token || token.length < TOKEN_FRAGMENT_WIDTH) continue;
    for (let i = 0; i + TOKEN_FRAGMENT_WIDTH <= token.length; i += 1) {
      if (value.includes(token.slice(i, i + TOKEN_FRAGMENT_WIDTH))) return true;
    }
  }
  return false;
}

/** 把敏感词与已知 token 替换为 *** */
export function redactText(text, tokens, sensitiveRe) {
  let raw = String(text ?? '');
  try {
    // 正则可能无 g 标志，补上以替换全部命中
    const flags = sensitiveRe.flags.includes('g') ? sensitiveRe.flags : sensitiveRe.flags + 'g';
    raw = raw.replace(new RegExp(sensitiveRe.source, flags), '***');
  } catch {}
  for (const token of tokens) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

/** agent token 登记表：每会话只留当前代和上一代，防无界增长 */
export function createAgentTokenRegistry({ max = 512 } = {}) {
  const known = new Set();
  const byConversation = new Map();

  /** 记录会话当前 token，丢弃两代前的旧 token */
  function remember(key, token) {
    const tk = String(token ?? '');
    if (!tk) return;
    const prev = byConversation.get(key);
    if (prev && prev[0] === tk) return;
    const next = prev ? [tk, prev[0]] : [tk];
    if (prev && prev[1]) known.delete(prev[1]);
    byConversation.set(key, next);
    known.add(tk);
    if (known.size > max) {
      // 只丢旧令牌，当前还在用的一个都不能丢
      const live = new Set([...byConversation.values()].map((pair) => pair[0]));
      for (const old of [...known]) {
        if (known.size <= max) break;
        if (!live.has(old)) known.delete(old);
      }
    }
  }

  /** 会话移除时一并摘掉它的 token */
  function forget(key) {
    const prev = byConversation.get(key);
    if (!prev) return;
    for (const tk of prev) known.delete(tk);
    byConversation.delete(key);
  }

  return { known, byConversation, max, remember, forget };
}

/** 把令牌检测与脱敏绑到一张登记表和敏感词正则上 */
export function createTokenAudit({ registry, sensitiveRe }) {
  const tokens = registry.known;
  // 记住这个聊天现在用的令牌
  function rememberAgentToken(key, token) { registry.remember(key, token); }
  // 聊天没了就把它的令牌一起忘掉
  function forgetAgentToken(key) { registry.forget(key); }
  // 文本是否含已知令牌片段
  function hasKnownTokenFragment(text) {
    return hasTokenFragment(text, tokens);
  }
  // 脱敏敏感词与已知令牌
  function redactSensitiveText(text) {
    return redactText(text, tokens, sensitiveRe);
  }
  // 只脱敏已知令牌
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of tokens) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    // 片段也要抹掉，否则两条拼起来仍是完整令牌
    return hasKnownTokenFragment(s) ? '***' : s;
  }
  return { rememberAgentToken, forgetAgentToken, hasKnownTokenFragment, redactSensitiveText, redactKnownTokensOnly };
}

// 把 [CQ: 的冒号换成全角，防被当成 CQ 码
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 把 JSON 字符串形式的单条消息还原，如 "\"你好\""
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}
