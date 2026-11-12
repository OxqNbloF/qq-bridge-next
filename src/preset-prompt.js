// 读、检查、改写「二代仿真」那套预设提示词
// 这套提示词规定 AI 怎么用工具、怎么在群里说话，改完要重启 DSH
// 这里只处理文字和 YAML 内容，不碰别的状态
import yaml from 'js-yaml';

export const PRESET_PERSONA_ID = 'persona';
export const PRESET_PROMPT_MAX_BYTES = 128 * 1024;

// 这几段是安全底线，缺了会提示，但不会拦住管理员保存
export const PRESET_REQUIRED_MARKERS = ['【二代仿真模式 —— 安全规则', '【二代仿真模式 —— 工具协议'];

// 下面这些内容必须保留，删了会让 AI 的权限边界失效、测试也会失败
// 保存时直接拒绝，不会写进文件
// 一代和二代预设需要的条目不一样，所以分开两套清单
export const PRESET_BLOCKING_SUBSTRINGS = [
  '你没有本地工具',
  '群友没有管理权限',
  'API 令牌',
  '角色由桥接注入',
  '不会自动发送到 QQ',
];
// 一代预设不用工具，所以工具那几条不适用，只要下面三条
// 这三条要和一代预设的原文对得上，不然控制台会把它锁死
export const PRESET_BLOCKING_SUBSTRINGS_V1 = [
  '群友没有管理权限',
  'API 令牌',
  '角色扮演由系统注入',
];
export const PRESET_MIN_BODY_CHARS = 500;

/** 取某个预设对应的硬性不变量清单（未知预设按更严的二代替处理）。 */
export function presetBlockingSubstrings(preset = 'v2') {
  return preset === 'v1' ? PRESET_BLOCKING_SUBSTRINGS_V1 : PRESET_BLOCKING_SUBSTRINGS;
}

/** 严格检查：返回不能保存的原因，空数组表示可以保存。 */
export function presetPromptBlockers(content, preset = 'v2') {
  const text = String(content ?? '');
  const blockers = [];
  if (!text.trim()) {
    blockers.push('仿真提示词不能为空');
    return blockers;
  }
  for (const needle of presetBlockingSubstrings(preset)) {
    if (!text.includes(needle)) {
      blockers.push(`缺少安全不变量「${needle}」：删除它会让 AI 的权限边界失效，并使 npm run test:audit 失败`);
    }
  }
  if (text.trim().length < PRESET_MIN_BODY_CHARS) {
    blockers.push(`正文过短（${text.trim().length} 字符 < ${PRESET_MIN_BODY_CHARS}）：疑似内容被误删`);
  }
  return blockers;
}

/**
 * 在 YAML 文字里找到 persona 那段的提示词位置（支持 >- / | 写法）。
 * @returns {object|null} 找到时返回行数组和起止位置，找不到返回 null
 */
export function locatePresetPromptBlock(text) {
  const lines = String(text ?? '').split('\n');
  const entryStart = lines.findIndex((line) => new RegExp(`^- id:\\s*${PRESET_PERSONA_ID}\\s*$`).test(line));
  if (entryStart < 0) return null;
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { entryEnd = i; break; }
  }
  let keyLine = -1;
  for (let i = entryStart; i < entryEnd; i += 1) {
    if (/^\s*prefix:\s*[>|][-+]?\s*$/.test(lines[i])) { keyLine = i; break; }
  }
  if (keyLine < 0) return null;
  const keyIndent = lines[keyLine].match(/^\s*/)[0].length;
  // 只有真正的内容行才推进块尾：块内的空行（段落分隔）会被后面的内容行重新纳入，
  // 而块尾的空行留给后续行，避免把 persona 与下一条注释之间的空行吞掉。
  let blockEnd = keyLine + 1;
  for (let i = keyLine + 1; i < entryEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= keyIndent) break;
    blockEnd = i + 1;
  }
  return { lines, entryStart, entryEnd, keyLine, keyIndent, blockEnd };
}

/** 取出 persona.prefix 真正的内容（YAML 已把折行展开）。 */
export function extractPresetPrefix(text) {
  let loaded;
  try {
    loaded = yaml.load(text);
  } catch {
    return null;
  }
  const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === PRESET_PERSONA_ID) : null;
  const prefix = entry?.config?.prefix;
  return typeof prefix === 'string' ? prefix : null;
}

/** 保存前先看看有没有问题，只提示，不拦住。 */
export function presetPromptWarnings(content) {
  const text = String(content ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('内容为空');
  for (const marker of PRESET_REQUIRED_MARKERS) {
    if (!text.includes(marker)) warnings.push(`缺少「${marker}…】段落：AI 的权限与工具边界可能被削弱`);
  }
  return warnings;
}

/**
 * 把新提示词写回 YAML 文字里，并检查写进去的和读出来的一模一样。
 * @param {string} text 原 YAML 全文
 * @param {string} content 新的提示词正文
 * @param {'v1'|'v2'} preset 预设代次（决定用哪一套硬性不变量）
 * @returns {string} 新的 YAML 全文
 */
export function renderPresetPromptYaml(text, content, preset = 'v2') {
  const loc = locatePresetPromptBlock(text);
  if (!loc) throw new Error('无法定位预设里的 prefix 块（文件结构可能已变化）');
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > PRESET_PROMPT_MAX_BYTES) {
    throw new Error(`仿真提示词过长（${(bytes / 1024).toFixed(1)} KB，上限 ${PRESET_PROMPT_MAX_BYTES / 1024} KB）`);
  }
  const blockers = presetPromptBlockers(normalized, preset);
  if (blockers.length) throw new Error(blockers.join('；'));
  // 新增行沿用文件的主导行尾，避免把 CRLF 文件写成更混乱的混合行尾。
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf >= lfOnly ? '\r\n' : '\n';
  const pad = ' '.repeat(loc.keyIndent + 2);
  // 只有「真正的空行」才写成空行；只含空格/Tab 的行必须保留原样（写成 pad + 原内容），
  // 不然它会被 YAML 当成空行，下面比对不通过，提示词就存不进去。
  const body = normalized.split('\n').map((line) => (line === '' ? '' : pad + line));
  // 外层用 '\n' 连接各行：CRLF 文件的行自带 '\r'，因此块的最后一行也要补一个 '\r'，
  // 否则它与下一行之间会变成 LF-only，把文件行尾弄得更混杂。
  const block = [`${' '.repeat(loc.keyIndent)}prefix: |-`, ...body].join(eol) + (eol === '\r\n' ? '\r' : '');
  const next = [...loc.lines.slice(0, loc.keyLine), block, ...loc.lines.slice(loc.blockEnd)].join('\n');
  const reparsed = extractPresetPrefix(next);
  if (reparsed === null) throw new Error('写入后 YAML 解析失败或找不到 persona.prefix');
  if (reparsed !== normalized) {
    throw new Error('写入校验失败：读回的提示词与新内容不一致，已放弃写入');
  }
  return next;
}
