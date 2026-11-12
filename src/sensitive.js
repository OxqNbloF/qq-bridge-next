// 出站文本的敏感信息审计正则（路径、凭据赋值）；
// 判断前先统一文字写法；别把 32 位十六进制算进来，令牌按精确名单处理

/** NFKC 归一并剥掉零宽与双向控制字符 */
export function normalizeSensitiveText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '');
}

/** 生成文本的等价形式集合，逐条判定 */
export function sensitiveTextForms(value) {
  const canonical = normalizeSensitiveText(value);
  // 去掉空白和 ._- 得到紧凑形式
  const compact = (text) => text.replace(/[\s._-]+/g, '');
  const forms = new Set([canonical, compact(canonical)]);
  // 只解码严格往返的 base64 片段，防误判
  for (const form of [...forms]) {
    for (const match of form.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
      const raw = match[0].replace(/-/g, '+').replace(/_/g, '/');
      const padded = raw.replace(/=+$/, '');
      if (padded.length % 4 === 1) continue;
      const buffer = Buffer.from(padded, 'base64');
      if (buffer.length === 0) continue;
      if (buffer.toString('base64').replace(/=+$/, '') !== padded) continue; // 非严格 base64
      const decoded = buffer.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(buffer)) continue;           // 非合法 UTF-8
      const text = normalizeSensitiveText(decoded);
      forms.add(text);
      forms.add(compact(text));
    }
  }
  return [...forms];
}

const BASE_SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

/** 结构化判定：保留 RegExp 形状，test 先归一化 */
export const SENSITIVE_RE = new class StructuredSensitiveRegExp extends RegExp {
  // 任一等价形式命中即判为敏感
  test(value) {
    return sensitiveTextForms(value).some((form) => BASE_SENSITIVE_RE.test(form));
  }
}(BASE_SENSITIVE_RE.source, BASE_SENSITIVE_RE.flags);

/** 原始正则，供替换使用 */
export const SENSITIVE_PATTERN = BASE_SENSITIVE_RE;
