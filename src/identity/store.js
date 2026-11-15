import fs from 'node:fs';
import { atomicWriteJson } from '../store/fs-atomic.js';
import { migrateDocument, stampSchema } from '../store/schema.js';
import { emptyIdentityDocument, resetIdentityConversation, redactIdentityAliases, revokeIdentityAliases as revokeAliasesInDoc, normalizeAliasText, recordObservedAlias, recordUnresolvedAlias, resolveAlias, validateIdentityDocument } from './registry.js';

export function createIdentityStore(b) {
  let doc = emptyIdentityDocument();
  let broken = false;
  let dirty = false;
  let timer = null;
  let fileStamp = null;
  const mentionIndexes = new Map();

  function loadIdentity() {
    let raw;
    try { raw = fs.readFileSync(b.IDENTITY_FILE, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return; raw = error; }
    try {
      if (raw instanceof Error) throw raw;
      fileStamp = statStamp();
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      migrateDocument('identity', parsed);
      doc = validateIdentityDocument(parsed);
    } catch (error) {
      broken = true;
      b.log(`⚠️ identity.json 无法使用：${error?.message ?? error}；身份功能降级为 QQ 直读，不会覆盖原文件`);
    }
  }

  function observeIdentity(input) {
    if (broken || b.cfg?.identity?.enabled === false || b.cfg?.identity?.learnFromChat === false) return;
    const now = new Date().toISOString();
    const observations = [
      ...(input.nickname ? [{ ...input, name: input.nickname, source: 'nickname' }] : []),
      ...(input.group && input.card ? [{ ...input, name: input.card, source: 'card' }] : []),
    ];
    let changed = false;
    for (const item of observations) {
      try { recordObservedAlias(doc, { ...item, now }); changed = true; }
      catch { b.log('⚠️ 忽略非法身份称呼'); }
    }
    if (changed && input.group) {
      const group = doc.people[String(input.qq)]?.groups[String(input.group).replace(/^group:/, '')];
      if (group) {
        group.interactions = (group.interactions ?? 0) + 1;
        group.lastInteractionAt = now;
      }
    }
    if (changed) queueSave();
  }

  function queueSave() {
    mentionIndexes.clear();
    dirty = true;
    if (timer) return;
    timer = b.setTimeout(() => {
      timer = null;
      saveIdentity();
    }, 1000);
    timer?.unref?.();
  }

  function saveIdentity() {
    if (timer) { b.clearTimeout(timer); timer = null; }
    if (broken || !dirty) return;
    try {
      if (statStamp() !== fileStamp) {
        broken = true;
        b.log('⚠️ identity.json 在启动后被外部修改；为避免覆盖新数据，停止写入并降级为 QQ 直读');
        return;
      }
      atomicWriteJson(b.IDENTITY_FILE, stampSchema('identity', structuredClone(doc)));
      fileStamp = statStamp();
      dirty = false;
    } catch (error) {
      b.log(`⚠️ identity.json 写入失败：${error?.message ?? error}；保留内存状态，退出前重试`);
    }
  }

  function editIdentity({ qq, group, name, aliases = [], remove = false, expectedUpdatedAt }) {
    if (broken || statStamp() !== fileStamp || expectedUpdatedAt !== (doc.updatedAt ?? '')) {
      const error = new Error('身份数据已变化或处于只读状态，请刷新后重试'); error.statusCode = 409; throw error;
    }
    if (!/^[1-9]\d{0,15}$/.test(String(qq)) || (group !== undefined && group !== '' && !/^[1-9]\d{0,15}$/.test(String(group))) || !Array.isArray(aliases)) {
      const error = new Error('QQ、群号或别名格式不正确'); error.statusCode = 400; throw error;
    }
    const next = structuredClone(doc);
    const now = new Date().toISOString();
    if (remove) delete next.people[qq];
    if (!remove) {
      const names = [...new Set([name, ...aliases])];
      if (names.length > 8) { const error = new Error('每次最多设置 8 个称呼'); error.statusCode = 400; throw error; }
      const person = next.people[qq] ??= { qq: String(qq), displayName: name, globalAliases: [], groups: {} };
      const scope = group ? (person.groups[group] ??= { aliases: [] }) : null;
      const observed = (scope ? scope.aliases : person.globalAliases).filter((alias) => alias.source !== 'manual');
      const manual = names.map((text) => ({ text, source: 'manual', confidence: 1, count: 1, status: 'active', firstSeenAt: now, lastSeenAt: now }));
      if (scope) { scope.card = name; scope.aliases = [...observed, ...manual]; }
      if (!scope) { person.displayName = name; person.globalAliases = [...observed, ...manual]; }
      person.updatedAt = now; person.updatedBy = 'console';
    }
    next.updatedAt = now;
    const validated = validateIdentityDocument(next);
    atomicWriteJson(b.IDENTITY_FILE, stampSchema('identity', validated));
    doc = validated;
    mentionIndexes.clear(); dirty = false; fileStamp = statStamp();
    b.log(`[identity] console ${remove ? 'delete' : 'edit'} ${qq}`);
    return structuredClone(doc);
  }

  return {
    resetIdentityContext: (key, removed) => {
      if (broken) throw new Error('身份库只读，隐私上下文清理未完成');
      resetIdentityConversation(doc, key, removed);
      queueSave(); saveIdentity();
      if (dirty || broken) throw new Error('身份清理未保存');
      const saved = validateIdentityDocument(JSON.parse(fs.readFileSync(b.IDENTITY_FILE, 'utf8')));
      if (JSON.stringify(saved) !== JSON.stringify(validateIdentityDocument(doc))) throw new Error('身份清理持久化验证失败');
      return true;
    },
    redactIdentitySource: (key, id, removed) => {
      if (broken) throw new Error('身份库只读，隐私删除的身份清理未完成');
      redactIdentityAliases(doc, key, id, removed);
      queueSave(); saveIdentity();
      if (dirty || broken) throw new Error('身份清理未保存');
    },
    revokeIdentityAliases: (key, options = {}) => {
      let currentStamp;
      try { currentStamp = statStamp(); } catch (error) { throw Object.assign(new Error(`身份库状态不可读，称呼撤销未完成：${error?.message ?? error}`), { statusCode: 503 }); }
      if (broken || currentStamp !== fileStamp) {
        if (!broken && currentStamp !== fileStamp) {
          broken = true;
          b.log('⚠️ identity.json 在启动后被外部修改；为避免覆盖新数据，停止写入并降级为 QQ 直读');
        }
        throw Object.assign(new Error('身份库只读，称呼撤销未完成'), { statusCode: 503 });
      }
      const draft = structuredClone(doc);
      const { changed } = revokeAliasesInDoc(draft, key, options);
      if (!changed && !dirty) return false;
      try {
        if (timer) { b.clearTimeout(timer); timer = null; }
        if (changed) draft.updatedAt = new Date().toISOString();
        const validated = validateIdentityDocument(draft);
        atomicWriteJson(b.IDENTITY_FILE, stampSchema('identity', validated));
        doc = validated;
        mentionIndexes.clear();
        dirty = false;
        fileStamp = statStamp();
      } catch (error) {
        throw Object.assign(new Error(`身份称呼撤销未保存：${error?.message ?? error}`), { statusCode: 503 });
      }
      return changed;
    },
    editIdentity,
    loadIdentity,
    observeIdentity,
    resolveIdentityAlias: (input) => {
      if (broken || b.cfg?.identity?.enabled === false) return null;
      const result = resolveAlias(doc, input);
      if (!result?.ambiguous || !input.conv) return result;
      try {
        recordUnresolvedAlias(doc, { conv: input.conv, text: normalizeAliasText(input.text) });
        queueSave();
      } catch {}
      return result;
    },
    resolveIdentityMentions: ({ conv, group, text }) => {
      if (broken || b.cfg?.identity?.enabled === false) return [];
      const exact = resolveAlias(doc, { group, text });
      if (exact) {
        if (exact.ambiguous && conv) { recordUnresolvedAlias(doc, { conv, text }); queueSave(); }
        return [exact];
      }
      const key = String(group ?? 'global');
      if (!mentionIndexes.has(key)) {
        if (mentionIndexes.size >= 16) mentionIndexes.delete(mentionIndexes.keys().next().value);
        const names = [...new Set(Object.values(doc.people).flatMap(person => [...person.globalAliases, ...(person.groups[key]?.aliases ?? [])]
          .filter(alias => alias.status === 'active' && alias.confidence >= 0.6).map(alias => normalizeAliasText(alias.text))))];
        mentionIndexes.set(key, names.filter(name => name.length >= 2).sort((a, b) => b.length - a.length)
          .map(name => ({ name, result: resolveAlias(doc, { group, text: name }) })).filter(item => item.result));
      }
      const input = String(text).normalize('NFKC').toLocaleLowerCase().slice(0, 4000);
      const hits = [];
      const spans = [];
      for (const item of mentionIndexes.get(key)) {
        const start = input.indexOf(item.name);
        if (start < 0 || spans.some(([from, to]) => start < to && start + item.name.length > from)) continue;
        if (/^[a-z0-9_]+$/.test(item.name) && (/[a-z0-9_]/.test(input[start - 1] ?? '') || /[a-z0-9_]/.test(input[start + item.name.length] ?? ''))) continue;
        spans.push([start, start + item.name.length]);
        hits.push(item.result);
        if (item.result.ambiguous && conv) { recordUnresolvedAlias(doc, { conv, text: item.name }); queueSave(); }
      }
      return hits;
    },
    observeResolvedIdentity: input => {
      if (broken || b.cfg?.identity?.enabled === false || b.cfg?.identity?.learnFromChat === false) return;
      try { recordObservedAlias(doc, input); queueSave(); }
      catch { b.log('⚠️ 忽略非法的结构化称呼'); }
    },
    activateLearnedAlias: (input) => {
      if (broken) throw new Error('身份库只读，不能晋升称呼');
      recordObservedAlias(doc, { ...input, source: 'learned' });
      queueSave();
    },
    identityDisplayName: (qq, group) => {
      if (broken || b.cfg?.identity?.enabled === false) return null;
      const person = Object.hasOwn(doc.people, String(qq)) ? doc.people[String(qq)] : null;
      if (!person) return null;
      if (group != null) {
        const groupId = String(group).replace(/^group:/, '');
        const scope = Object.hasOwn(person.groups, groupId) ? person.groups[groupId] : null;
        return scope?.aliases.find((alias) => alias.source === 'manual' && alias.status === 'active')?.text ?? scope?.card ?? scope?.aliases.find((alias) => alias.status === 'active')?.text ?? null;
      }
      return person.globalAliases.find((alias) => alias.source === 'manual' && alias.status === 'active')?.text ?? person.displayName;
    },
    identityAliases: (qq, group) => {
      if (broken || b.cfg?.identity?.enabled === false) return [];
      const person = Object.hasOwn(doc.people, String(qq)) ? doc.people[String(qq)] : null;
      if (!person) return [];
      const groupId = group == null ? null : String(group).replace(/^group:/, '');
      const groupAliases = groupId != null && Object.hasOwn(person.groups, groupId) ? person.groups[groupId].aliases : [];
      return [...new Set([...groupAliases, ...person.globalAliases]
        .filter((alias) => alias.status === 'active')
        .map((alias) => alias.text))];
    },
    renderIdentityRoster: (conv, { max = b.cfg?.identity?.renderAliasTableMax ?? 20, exposeQq = b.cfg?.identity?.exposeQqInPrompt === true } = {}) => {
      if (broken || b.cfg?.identity?.enabled === false || !String(conv).startsWith('group:')) return '';
      const group = String(conv).slice(6);
      const renderLabel = (value) => b.sanitizeUntrustedText(value).replace(/[（）；：]/g, '·');
      return Object.values(doc.people)
        .flatMap((person) => {
          if (b.cfg?.architecture?.gateV2 === true && b.gateDecide) {
            const decision = b.gateDecide({ kind: 'group', id: Number(group), qq: person.qq });
            if (!decision.allowed || !decision.flags.context) return [];
          }
          const scope = person.groups[group];
          const active = scope?.aliases.filter((alias) => alias.status === 'active') ?? [];
          const name = active.find((alias) => alias.source === 'manual')?.text ?? scope?.card ?? active[0]?.text;
          if (!name) return [];
          const aliases = [...new Set(active.map((alias) => alias.text).filter((alias) => alias !== name))].slice(0, 2);
          const lastSeenAt = Date.parse(scope?.lastInteractionAt ?? '') || active.reduce((latest, alias) => Math.max(latest, Date.parse(alias.lastSeenAt ?? '') || 0), 0);
          return [{ name, qq: person.qq, aliases, count: scope?.interactions ?? null, lastSeenAt }];
        })
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, Math.max(0, Math.min(50, Number(max) || 0)))
        .map((person) => {
          const details = [
            ...(exposeQq ? [`QQ:${person.qq}`] : []),
            ...(person.aliases.length ? [`别名：${person.aliases.map(renderLabel).join('/')}`] : []),
            ...(person.lastSeenAt ? [`最近 ${b.describeAge(person.lastSeenAt)}${person.count == null ? '' : `；互动 ${person.count} 次`}`] : []),
          ];
          return `${renderLabel(person.name)}${details.length ? `（${details.join('；')}）` : ''}`;
        })
        .join('\n');
    },
    identitySnapshot: () => structuredClone(doc),
    identityWritable: () => !broken && statStamp() === fileStamp,
    flushIdentity: saveIdentity,
  };

  function statStamp() {
    try {
      const stat = fs.statSync(b.IDENTITY_FILE);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}
