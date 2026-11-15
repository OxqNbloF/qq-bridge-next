// 群成员策略存储（state/member-policy.json）；docs/architecture-refactor.md §5.3
// 读不出来不当空表（那是全放行）：标记 broken，由门禁 fail-closed
import fs from 'node:fs';
import { atomicWriteJson } from './fs-atomic.js';
import { migrateDocument, stampSchema } from './schema.js';
import { FLAG_KEYS, MEMBER_MODES, normalizeFlags, decide } from '../gate/decide.js';
import { normalizeIdList } from '../policy/access.js';

const QQ_RE = /^[1-9]\d{0,15}$/;
const GROUP_RE = /^group:[1-9]\d{0,15}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NO_FLAGS = Object.freeze({ respond: false, converse: false, context: false, memory: false });

// 按数字升序重建映射，保证写盘 diff 可读
const sortedMap = (obj, keyRe, where, fn) => {
  if (!isObj(obj)) throw new Error(`${where} 必须是对象`);
  const num = (k) => Number(k.slice(k.indexOf(':') + 1));
  const out = {};
  for (const k of Object.keys(obj).sort((a, b) => num(a) - num(b))) {
    if (!keyRe.test(k)) throw new Error(`${where} 的键非法：${JSON.stringify(k)}`);
    out[k] = fn(obj[k], `${where}.${k}`);
  }
  return out;
};

function cleanFlags(flags, where) {
  if (!isObj(flags)) throw new Error(`${where} 的 flags 必须是对象`);
  for (const [k, v] of Object.entries(flags)) {
    if (!FLAG_KEYS.includes(k) || typeof v !== 'boolean') throw new Error(`${where} 的 flags.${k} 非法`);
  }
  return normalizeFlags(flags);
}

function cleanRule(rule, where) {
  if (!isObj(rule)) throw new Error(`${where} 必须是对象`);
  const out = { qq: where.slice(where.lastIndexOf('.') + 1), flags: cleanFlags(rule.flags ?? {}, where) };
  if (rule.aliases != null) {
    // 别名只作展示，仍按身份系统的入库规则挡注入
    if (!Array.isArray(rule.aliases) || rule.aliases.some((a) => typeof a !== 'string' || !a.trim() || a.length > 32 || /[\r\n【】]/.test(a))) {
      throw new Error(`${where} 的 aliases 非法`);
    }
    if (rule.aliases.length) out.aliases = rule.aliases.map((a) => a.trim());
  }
  if (rule.note != null) {
    if (typeof rule.note !== 'string' || rule.note.length > 200) throw new Error(`${where} 的 note 非法`);
    if (rule.note) out.note = rule.note;
  }
  for (const k of ['updatedAt', 'updatedBy']) if (typeof rule[k] === 'string') out[k] = rule[k];
  return out;
}

/** 校验并规范化整份文档；有一处非法就整份拒收 */
export function validateMemberPolicyDoc(doc) {
  if (!isObj(doc)) throw new Error('member-policy 顶层必须是对象');
  const out = {
    groups: sortedMap(doc.groups ?? {}, GROUP_RE, 'groups', (pol, where) => {
      if (!isObj(pol) || !MEMBER_MODES.includes(pol.mode)) throw new Error(`${where} 的 mode 非法`);
      const g = { mode: pol.mode, rules: sortedMap(pol.rules ?? {}, QQ_RE, `${where}.rules`, cleanRule) };
      for (const k of ['updatedAt', 'updatedBy']) if (typeof pol[k] === 'string') g[k] = pol[k];
      return g;
    }),
    private: sortedMap(doc.private ?? {}, QQ_RE, 'private', cleanFlags),
    // 全局成员规则：对所有群和私聊生效，群内/私聊自己的规则优先（承接旧 ignore.sendQQ）
    global: sortedMap(doc.global ?? {}, QQ_RE, 'global', cleanRule),
  };
  for (const k of ['updatedAt', 'ignoreMigratedAt']) if (typeof doc[k] === 'string') out[k] = doc[k];
  return out;
}

const deepFreeze = (v) => { if (isObj(v)) { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };

export function createMemberPolicyStore(b) {
  let doc = deepFreeze(validateMemberPolicyDoc({}));
  let broken = false;
  let epoch = 0;
  let loaded = false;

  function loadMemberPolicy() {
    loaded = true;
    let raw;
    try { raw = fs.readFileSync(b.MEMBER_POLICY_FILE, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        doc = deepFreeze(validateMemberPolicyDoc({}));
        broken = false;
        return;
      }
      raw = error;
    }
    try {
      if (raw instanceof Error) throw raw;
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      migrateDocument('member-policy', parsed);
      doc = deepFreeze(validateMemberPolicyDoc(parsed));
      broken = false;
    } catch (error) {
      broken = true;
      b.log(`⚠️ member-policy.json 无法使用：${error?.message ?? error}；已只读降级，群聊一律不回应（不会覆盖原文件）`);
    }
  }

  /** 按需加载一次策略文件，避免 gateV2 关闭时以空文档覆盖已有规则 */
  function ensureMemberPolicyLoaded() {
    if (!loaded) loadMemberPolicy();
    return loaded;
  }

  function assertWritable() {
    if (!loaded) throw new Error('member-policy.json 尚未加载，不能修改');
    if (broken) throw new Error('member-policy.json 处于只读降级状态，不能修改');
  }

  /** 门禁 decide 的输入切片；policy 是冻结对象，直接读不要改 */
  const memberPolicySnapshot = () => ({ policy: doc, policyBroken: broken, policyEpoch: epoch });
  /** 带上当前策略快照跑一次门禁；入口与发送复查共用 */
  const gateDecide = (input) => decide({ cfg: b.cfg, mode: b.modeForKey ? b.modeForKey(`${input.kind}:${input.id}`) : b.currentMode, ...input, ...memberPolicySnapshot() });

  // 改内存副本 → 校验 → 写盘成功后才生效
  function apply(change, summary, updatedBy) {
    assertWritable();
    const now = new Date(Math.max(Date.now(), (Date.parse(doc.updatedAt ?? '') || 0) + 1)).toISOString();
    const draft = structuredClone(doc);
    const result = change(draft, { updatedAt: now, updatedBy: String(updatedBy ?? 'unknown') });
    const next = validateMemberPolicyDoc({ ...draft, updatedAt: now });
    atomicWriteJson(b.MEMBER_POLICY_FILE, stampSchema('member-policy', { ...next }));
    doc = deepFreeze(next);
    epoch += 1;
    b.appendActivity(`成员策略 ${summary}（${updatedBy ?? 'unknown'}）`);
    return result;
  }

  // 先挡键：__proto__ 之类赋值不会成为自有键，校验看不见
  const checkKeys = (group, qq) => {
    if (!GROUP_RE.test(String(group))) throw new Error(`群 key 非法：${JSON.stringify(group)}`);
    if (qq !== undefined && !QQ_RE.test(String(qq))) throw new Error(`QQ 号非法：${JSON.stringify(qq)}`);
  };

  const bits = (flags) => FLAG_KEYS.map((k) => (flags?.[k] === false ? '0' : '1')).join('');

  /** 整组替换（mode + rules） */
  function setGroupPolicy(group, { mode, rules = {} } = {}, updatedBy) {
    checkKeys(group);
    assertWritable();
    return apply((d, stamp) => {
      d.groups[group] = { mode, rules: Object.fromEntries(Object.entries(rules).map(([qq, r]) => [qq, { ...r, ...stamp }])), ...stamp };
    }, `${group} 整组替换：${doc.groups[group]?.mode ?? '无'} → ${mode}，${Object.keys(rules).length} 条规则`, updatedBy);
  }

  /** 单成员增改；flags 只改传入的项，群不存在则按 all 新建 */
  function setMemberRule(group, qq, { flags, aliases, note } = {}, updatedBy) {
    checkKeys(group, qq);
    assertWritable();
    const before = doc.groups[group]?.rules[qq];
    return apply((d, stamp) => {
      const g = d.groups[group] ??= { mode: 'all', rules: {}, ...stamp };
      Object.assign(g, stamp);
      const rule = { ...g.rules[qq], flags: { ...g.rules[qq]?.flags, ...flags }, ...stamp };
      if (aliases !== undefined) rule.aliases = aliases;
      if (note !== undefined) rule.note = note;
      g.rules[qq] = rule;
    }, `${group} 成员 ${qq}：${before ? bits(before.flags) : '无'} → ${bits({ ...before?.flags, ...flags })}（回应/对话/上下文/记忆）`, updatedBy);
  }

  /** 删除单成员规则；幂等，不存在时不写盘 */
  function deleteMemberRule(group, qq, updatedBy) {
    checkKeys(group, qq);
    assertWritable();
    if (!doc.groups[group]?.rules[qq]) return false;
    apply((d, stamp) => {
      delete d.groups[group].rules[qq];
      Object.assign(d.groups[group], stamp);
    }, `${group} 删除成员 ${qq} 的规则`, updatedBy);
    return true;
  }

  /** 一次性把旧 ignore.sendQQ 迁成四项全关的全局规则；返回迁移报告 */
  function migrateIgnoreList(cfg = b.cfg) {
    if (!loaded) throw new Error('member-policy.json 尚未加载，不能修改');
    const list = [...new Set(normalizeIdList(cfg.ignore?.sendQQ).map((s) => String(Number(s))))];
    if (doc.ignoreMigratedAt || !list.length) return { already: !!doc.ignoreMigratedAt, migrated: [], skipped: [] };
    const report = { already: false, migrated: [], skipped: [] };
    for (const qq of list) {
      // 管理员永不忽略；已有规则的不覆盖
      if (!QQ_RE.test(qq) || qq === String(cfg.ownerQQ ?? '') || doc.global[qq]) report.skipped.push(qq);
      else report.migrated.push(qq);
    }
    apply((d, stamp) => {
      for (const qq of report.migrated) d.global[qq] = { flags: { ...NO_FLAGS }, note: '迁移自 ignore.sendQQ', ...stamp };
      d.ignoreMigratedAt = stamp.updatedAt;
    }, `迁移 ignore.sendQQ：${report.migrated.length} 条，跳过 ${report.skipped.length} 条`, 'migration');
    return report;
  }

  return { loadMemberPolicy, ensureMemberPolicyLoaded, memberPolicySnapshot, gateDecide, setGroupPolicy, setMemberRule, deleteMemberRule, migrateIgnoreList };
}
