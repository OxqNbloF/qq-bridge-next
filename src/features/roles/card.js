// 人格卡 roles/<名称>.md 的检查、读写、摘要与告警
import fs from 'node:fs';
import path from 'node:path';
import { roleCharStats, parseRoleSections, GEN1_ROLE_LINE_RE } from '../../role-card.js';
import { atomicWriteText } from '../../store/fs-atomic.js';

// 创建人格卡读写与检查函数，b 是桥接的入口
export function createRoleCards(b) {
  // 人格卡目录，每条消息前写进去，改了马上生效
  const ROLES_DIR = path.join(b.ROOT, 'roles');
  const ROLE_NAME_MAX = 40;
  const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
  // 把写进去的上限改成合法的正整数
  function applyRoleInjectLimit(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return b.ROLE_INJECT_MAX_CHARS_DEFAULT;
    return Math.min(20000, Math.max(1000, Math.round(n)));
  }
  const ROLE_RESERVED_NAMES = new Set(['README']);
  // 拒绝 Windows 保留设备名，防写入失败或挂起
  const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  ]);

  // 角色名对应的 .md 文件路径
  function roleFilePath(name) {
    return path.join(ROLES_DIR, name + '.md');
  }

  // 取卡片第一行有意义的文本
  function firstMeaningfulLine(content) {
    for (const line of String(content ?? '').split('\n')) {
      const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (t) return t.slice(0, 80);
    }
    return '';
  }

  // 生成卡片的告警列表
  function roleWarnings(content, mode = 'v2') {
    const text = String(content ?? '');
    const warnings = [];
    const stats = roleCharStats(text);
    const injected = mode === 'v1' ? stats.v1 : stats.v2;
    if (injected > b.roleInjectMaxChars) {
      warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${b.roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
    }
    // 只提示未用模式标记分开的小节，避免误报
    const untagged = parseRoleSections(text)
      .filter((section) => section.mode === 'all')
      .map((section) => section.lines.join('\n'))
      .join('\n');
    if (GEN1_ROLE_LINE_RE.test(untagged)) {
      warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
    }
    if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
      warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
    }
    return warnings;
  }

  // 汇总所有角色卡的摘要与字数
  function roleSummaries() {
    return b.listRoles().map((name) => {
      const file = roleFilePath(name);
      try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        const stats = roleCharStats(content);
        return {
          name,
          bytes: stat.size,
          chars: content.length,
          lines: content.split('\n').length,
          mtime: stat.mtimeMs,
          excerpt: firstMeaningfulLine(content),
          // 两种模式各自实际写进去的字数
          injectedV1: Math.min(stats.v1, b.roleInjectMaxChars),
          injectedV2: Math.min(stats.v2, b.roleInjectMaxChars),
          charsV1: stats.v1,
          charsV2: stats.v2,
          hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
          truncated: stats.v1 > b.roleInjectMaxChars || stats.v2 > b.roleInjectMaxChars,
          warnings: roleWarnings(content).length,
        };
      } catch {
        return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
      }
    });
  }

  // 检查角色名，不合法就报错
  function validateRoleName(raw) {
    const name = b.sanitizeRoleName(raw);
    if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
    if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
    if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
    if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
    return name;
  }

  // 检查人格卡内容大小与格式
  function validateRoleContent(raw) {
    const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!content) throw new Error('人格内容不能为空');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ROLE_CONTENT_MAX_BYTES) {
      throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
    }
    return content;
  }

  // 读取人格卡内容
  function readRoleContent(name) {
    return fs.readFileSync(roleFilePath(name), 'utf8');
  }

  // 检查通过后一次写完人格卡
  function writeRoleContent(name, content) {
    fs.mkdirSync(ROLES_DIR, { recursive: true });
    atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
  }

  return { applyRoleInjectLimit, roleFilePath, firstMeaningfulLine, roleWarnings, roleSummaries, validateRoleName, validateRoleContent, readRoleContent, writeRoleContent, ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX, ROLES_DIR };
}
