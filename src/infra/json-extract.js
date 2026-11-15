/** 从模型输出抠出 JSON 数组：扫描配平括号，优先含对象的 */
export function extractJsonArray(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    if (Array.isArray(direct)) return direct;
  } catch {}
  if (raw.length > 400_000) return null; // 超长文本不扫描，避免 O(n²)
  const MAX_CANDIDATES = 32;
  // 扫描尝试次数设上限，防全是 [ 时 O(n²) 卡死
  let attempts = 0;
  const MAX_SCAN_ATTEMPTS = 64;
  const candidates = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '[') continue;
    if (candidates.length >= MAX_CANDIDATES || attempts >= MAX_SCAN_ATTEMPTS) break;
    attempts += 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(i, j + 1));
          break; // 本括号段扫完，内部 [ 交给外层继续
        }
      }
    }
  }
  let fallback = null;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    if (parsed.some((item) => item && typeof item === 'object' && !Array.isArray(item))) return parsed;
    if (fallback === null) fallback = parsed;
  }
  return fallback;
}

// 把提取结果读成候选列表
