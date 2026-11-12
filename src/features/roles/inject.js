// 把人格卡放进提示词：按模式取段、截断、提醒和控制频率
import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../../md-to-plain.js';
import { selectRoleText, GEN1_ROLE_LINE_RE } from '../../role-card.js';

// 做出管人格卡放进提示词的小工具组
export function createRoleInject(b) {
  // 读当前角色与角色卡生成提示，按文件元数据缓存
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（缓存，不截断）
  function roleRawContent() {
    try {
      const rs = b.readRoleState();
      if (!rs.role) return '';
      // 读的时候也要检查名字，防止有人借名字读电脑上的别的文件
      const safeName = b.sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(b.ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(b.ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(b.ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 须含文件名和大小，不能只看 mtime
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 先按〔一代〕/〔二代〕筛小节，再截断
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > b.roleInjectMaxChars ? truncateText(selected, b.roleInjectMaxChars) : selected;
  }
  // 一代模式的角色提示
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代角色提示：去掉一代状态机指令，改写示例
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 二代示例里把中文间的分条空格改成逗号
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测中文之间用空格的写法，给软提醒
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测消息在半句处断开，只提醒不拦截
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 常见完整短句结尾，不算半句
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  // 放进提示词的节奏：卡变了或每 N 次唤醒给全文，其余只给一行提醒
  /**
   * 决定这次唤醒给全文还是一行提醒
   * @param {string|null} key 会话 key，null 时直接全量
   * @param {object} opts 是否允许只发一行提醒、是否强制全量
   * @returns {{ text: string, full: boolean }}
   */
  function roleForWake(key, { allowStub = true, forceFull = false } = {}) {
    const rs = b.readRoleState();
    if (!rs.role) return { text: '', full: false };
    const every = Math.max(1, Number(b.cfg.role?.injectEveryNWakes) || 4);
    // 标记里带上 DSH 会话编号，会话重建后马上给全文
    const sessionTag = key ? String(b.state.sessions[key] ?? '') : '';
    const sig = `${b.roleCardSignature()}@${sessionTag}`;
    // 生成全卡文本
    const fullText = () => currentRoleHintV2();
    let full = true;
    if (key && allowStub) {
      const store = b.roleInjectStore();
      const rec = store[key] && typeof store[key] === 'object' ? store[key] : { sig: '', n: 0 };
      const n = Math.max(0, Number(rec.n) || 0);
      const now = Date.now();
      // 8 秒内重复构建沿用上次判定，避免多耗计数
      const dedupeMs = Number.isFinite(Number(b.cfg.role?.injectDedupeWindowMs)) ? Number(b.cfg.role.injectDedupeWindowMs) : 8000;
      const sameWake = dedupeMs > 0 && rec.lastAt && now - Number(rec.lastAt) < dedupeMs && rec.sig === sig;
      if (rec.sig !== sig) {
        rec.sig = sig;
        rec.n = 1;
        rec.lastFull = true;
        rec.lastAt = now;
        full = true;
      } else if (sameWake) {
        full = rec.lastFull === true;
      } else {
        full = forceFull || every <= 1 || n % every === 0;
        rec.n = n + 1;
        rec.lastFull = full;
        rec.lastAt = now;
      }
      store[key] = rec;
      b.saveRoleInjectStore();
    }
    if (!full) {
      return {
        text: `【当前角色】${rs.role}（角色卡已在本会话前面完整给过，继续按它说话；需要回顾可调用 qq_get_prompt）`,
        full: false
      };
    }
    return { text: fullText(), full: true };
  }

  // 二代模式的角色提示
  function currentRoleHintV2() {
    // 先按标记挑段落；没标记的老卡片再逐行过滤一遍
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 整行过滤一代指令；用 role-card.js 那份正则
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，只把说法改成二代的
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  return { roleRawContent, roleHintForMode, currentRoleHint, isCjkLikeChar, convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning, roleForWake, currentRoleHintV2 };
}
