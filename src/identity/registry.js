import { SENSITIVE_RE } from '../sensitive.js';
import { sanitizeUntrustedText } from '../qq-model-view.js';

const QQ_RE = /^[1-9]\d{0,15}$/;
const GROUP_RE = /^[1-9]\d{0,15}$/;
const CONV_RE = /^(?:group|private):[1-9]\d{0,15}$/;
const MAX_ALIASES_PER_USER = 8;
const MAX_UNRESOLVED = 1000;
const SOURCES = new Set(['card', 'nickname', 'at', 'quote', 'learned', 'manual']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function emptyIdentityDocument() {
  return { people: {}, unresolved: [] };
}

export function validateIdentityDocument(doc) {
  if (!isRecord(doc) || !isRecord(doc.people) || !Array.isArray(doc.unresolved ?? [])) throw new Error('identity 文档结构非法');
  const people = {};
  for (const [qq, person] of Object.entries(doc.people).sort(([a], [b]) => Number(a) - Number(b))) {
    if (!QQ_RE.test(qq) || !isRecord(person) || String(person.qq) !== qq || !isRecord(person.groups) || !Array.isArray(person.globalAliases)) throw new Error(`identity.people.${qq} 非法`);
    const normalized = {
      qq,
      displayName: cleanAlias(person.displayName, `identity.people.${qq}.displayName`),
      globalAliases: person.globalAliases.map((alias, i) => cleanAliasRecord(alias, `identity.people.${qq}.globalAliases.${i}`)),
      groups: Object.fromEntries(Object.entries(person.groups).map(([group, value]) => {
        if (!GROUP_RE.test(group) || !isRecord(value) || !Array.isArray(value.aliases)) throw new Error(`identity.people.${qq}.groups.${group} 非法`);
        if (value.interactions != null && (!Number.isSafeInteger(value.interactions) || value.interactions < 0)) throw new Error(`identity.people.${qq}.groups.${group}.interactions 非法`);
        if (value.lastInteractionAt != null && (typeof value.lastInteractionAt !== 'string' || !Number.isFinite(Date.parse(value.lastInteractionAt)))) throw new Error(`identity.people.${qq}.groups.${group}.lastInteractionAt 非法`);
        return [group, {
          ...(value.card ? { card: cleanAlias(value.card, `identity.people.${qq}.groups.${group}.card`) } : {}),
          aliases: value.aliases.map((alias, i) => cleanAliasRecord(alias, `identity.people.${qq}.groups.${group}.aliases.${i}`)),
          ...(value.interactions == null ? {} : { interactions: value.interactions }),
          ...(value.lastInteractionAt == null ? {} : { lastInteractionAt: value.lastInteractionAt }),
        }];
      })),
      ...(typeof person.updatedAt === 'string' ? { updatedAt: person.updatedAt } : {}),
      ...(typeof person.updatedBy === 'string' ? { updatedBy: person.updatedBy } : {}),
    };
    limitAliases(normalized);
    people[qq] = normalized;
  }
  const unresolved = (doc.unresolved ?? []).map((item, i) => {
    if (!isRecord(item) || !CONV_RE.test(item.conv) || !Number.isSafeInteger(item.count) || item.count < 1 || typeof item.lastSeenAt !== 'string' || !Number.isFinite(Date.parse(item.lastSeenAt))) throw new Error(`identity.unresolved.${i} 非法`);
    return { conv: item.conv, text: cleanAlias(item.text, `identity.unresolved.${i}.text`), count: item.count, lastSeenAt: item.lastSeenAt };
  }).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, MAX_UNRESOLVED);
  return { people, unresolved, ...(typeof doc.updatedAt === 'string' ? { updatedAt: doc.updatedAt } : {}) };
}

export function upsertObservedAlias(doc, { qq, group, name, source, now = new Date().toISOString() }) {
  return recordObservedAlias(validateIdentityDocument(doc), { qq, group, name, source, now });
}

/** Mutates a validated in-memory document; use upsertObservedAlias at external boundaries. */
export function recordObservedAlias(doc, { qq, group, name, source, conv, messageId, sources = [], now = new Date().toISOString() }) {
  const groupId = normalizeGroupId(group);
  if (!QQ_RE.test(String(qq)) || (groupId != null && !GROUP_RE.test(groupId)) || !['card', 'nickname', 'learned', 'at', 'quote'].includes(source)) throw new Error('身份观察参数非法');
  const text = cleanAlias(name, 'alias');
  const person = doc.people[qq] ??= { qq, displayName: text, globalAliases: [], groups: {} };
  person.displayName = text;
  const list = groupId == null ? person.globalAliases : (person.groups[groupId] ??= { aliases: [] }).aliases;
  const found = list.find((alias) => alias.text === text && alias.source === source);
  if (found) {
    found.count += 1;
    found.lastSeenAt = now;
    found.status = 'active';
  } else {
    list.push({ text, source, confidence: ['at', 'quote'].includes(source) ? 1 : source === 'card' ? 0.9 : 0.8, count: 1, firstSeenAt: now, lastSeenAt: now, status: 'active' });
  }
  const alias = list.find(alias => alias.text === text && alias.source === source);
  for (const evidence of [...sources, ...(conv && messageId != null ? [{ conv, id: String(messageId) }] : [])]) {
    if (!CONV_RE.test(evidence?.conv) || typeof evidence.id !== 'string') continue;
    alias.sources = [...(alias.sources ?? []).filter(item => item.conv !== evidence.conv || item.id !== evidence.id), { conv: evidence.conv, id: evidence.id }].slice(-64);
  }
  if (groupId != null && source === 'card') person.groups[groupId].card = text;
  const supporting = Object.values(person.groups).flatMap(scope => scope.aliases.filter(alias => alias.status === 'active' && normalizeAliasText(alias.text) === normalizeAliasText(text)));
  if (groupId != null && Object.values(person.groups).filter(scope => scope.aliases.some(alias => supporting.includes(alias))).length >= 3) {
    let global = person.globalAliases.find(alias => normalizeAliasText(alias.text) === normalizeAliasText(text));
    if (!global) {
      global = { text, source: 'learned', confidence: 0.8, count: 3, firstSeenAt: now, lastSeenAt: now, status: 'active' };
      person.globalAliases.push(global);
    }
    if (global.source === 'learned') {
      global.sources ??= [];
      for (const evidence of supporting.flatMap(alias => alias.sources ?? [])) {
        if (!global.sources.some(item => item.conv === evidence.conv && item.id === evidence.id)) global.sources.push(evidence);
      }
      global.sources = global.sources.slice(-64);
    }
  }
  limitAliases(person);
  person.updatedAt = now;
  person.updatedBy = 'pipeline';
  doc.updatedAt = now;
  return doc;
}

export function recordUnresolvedAlias(doc, { conv, text, now = new Date().toISOString() }) {
  if (!CONV_RE.test(String(conv))) throw new Error('身份会话非法');
  const alias = cleanAlias(normalizeAliasText(text), 'unresolved.text');
  const found = doc.unresolved.find((item) => item.conv === conv && item.text === alias);
  if (found) {
    found.count += 1;
    found.lastSeenAt = now;
  } else {
    doc.unresolved.push({ conv, text: alias, count: 1, lastSeenAt: now });
  }
  doc.unresolved.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  doc.unresolved.length = Math.min(doc.unresolved.length, MAX_UNRESOLVED);
  doc.updatedAt = now;
  return doc;
}

export function resolveAlias(doc, { group, text }) {
  const key = normalizeAliasText(text);
  if (!key || key.length > 32) return null;
  const groupId = normalizeGroupId(group);
  if (groupId != null && !GROUP_RE.test(groupId)) throw new Error(`群号非法：${JSON.stringify(group)}`);
  for (const scope of [groupId, null]) {
    const hits = Object.values(doc.people).filter((person) => {
      const aliases = scope == null
        ? person.globalAliases
        : person.groups[scope]?.aliases ?? [];
      return aliases.some((alias) => alias.status === 'active' && normalizeAliasText(alias.text) === key);
    }).map((person) => person.qq);
    const unique = [...new Set(hits)];
    if (unique.length === 1) return { qq: unique[0], by: scope == null ? 'global' : `group:${scope}` };
    if (unique.length > 1) return { ambiguous: true, qqs: unique.sort((a, b) => Number(a) - Number(b)) };
  }
  return /^\d{5,12}$/.test(key) ? { qq: key, by: 'qq-literal' } : null;
}

function cleanAlias(value, where) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32 || /[\r\n【】]/.test(value) || SENSITIVE_RE.test(value)) throw new Error(`${where} 非法`);
  const text = sanitizeUntrustedText(value).trim();
  if (!text || text.length > 32) throw new Error(`${where} 非法`);
  return text;
}

function cleanAliasRecord(alias, where) {
  if (!isRecord(alias) || !SOURCES.has(alias.source) || !['candidate', 'active', 'rejected'].includes(alias.status) || !Number.isFinite(alias.confidence) || alias.confidence < 0 || alias.confidence > 1 || !Number.isSafeInteger(alias.count) || alias.count < 1) throw new Error(`${where} 非法`);
  return {
    text: cleanAlias(alias.text, `${where}.text`), source: alias.source, confidence: alias.confidence, count: alias.count,
    ...(typeof alias.firstSeenAt === 'string' ? { firstSeenAt: alias.firstSeenAt } : {}),
    ...(typeof alias.lastSeenAt === 'string' ? { lastSeenAt: alias.lastSeenAt } : {}),
    ...(Array.isArray(alias.sources) ? { sources: alias.sources.filter(item => CONV_RE.test(item?.conv) && typeof item.id === 'string').slice(-64).map(item => ({ conv: item.conv, id: item.id })) } : {}),
    status: alias.status,
  };
}

function limitAliases(person) {
  const lists = [person.globalAliases, ...Object.values(person.groups).map((group) => group.aliases)];
  const entries = lists.flatMap((list) => list.filter(alias => alias.source !== 'manual').map((alias) => ({ list, alias })));
  if (entries.length <= MAX_ALIASES_PER_USER) return;
  entries.sort((a, b) => a.alias.confidence - b.alias.confidence || a.alias.count - b.alias.count || (Date.parse(a.alias.lastSeenAt ?? '') || 0) - (Date.parse(b.alias.lastSeenAt ?? '') || 0));
  while (entries.length > MAX_ALIASES_PER_USER) {
    const weakest = entries.shift();
    weakest.list.splice(weakest.list.indexOf(weakest.alias), 1);
  }
}

export function normalizeAliasText(value) {
  return sanitizeUntrustedText(String(value ?? '')).normalize('NFKC').replace(/[@\s\u200b-\u200f\u2060\ufeff]/g, '').toLocaleLowerCase();
}

function normalizeGroupId(group) {
  return group == null ? null : String(group).replace(/^group:/, '');
}

// 清理整个会话的身份派生副本；只保留人工和可证明独立的其他来源。
export function resetIdentityConversation(doc, key, removed = []) {
  doc.unresolved = (doc.unresolved ?? []).filter(item => item.conv !== key);
  for (const [qq, person] of Object.entries(doc.people)) {
    const local = key.startsWith('group:') ? person.groups[key.slice(6)] : null;
    const revoked = new Set([
      ...(local?.aliases ?? []).filter(alias => alias.source !== 'manual').map(alias => normalizeAliasText(alias.text)),
      ...removed.filter(item => item.kind === 'alias' && item.subject_uid === qq).map(item => normalizeAliasText(item.content)),
    ]);
    const keep = (alias, isLocal = false) => {
      if (alias.source === 'manual') return true;
      const sources = alias.sources ?? [];
      if (isLocal || sources.some(item => item.conv === key)) {
        revoked.add(normalizeAliasText(alias.text));
        // 混合来源不是独立副本，宁可重新学习，不保留污染的统计/置信度。
        return false;
      }
      if (!sources.length && (key === `private:${qq}` || (alias.source === 'learned' && revoked.has(normalizeAliasText(alias.text))))) return false;
      return true;
    };
    if (local) {
      local.aliases = local.aliases.filter(alias => keep(alias, true));
      delete local.card;
      delete local.interactions;
      delete local.lastInteractionAt;
    }
    for (const scope of Object.values(person.groups)) if (scope !== local) scope.aliases = scope.aliases.filter(alias => keep(alias));
    person.globalAliases = person.globalAliases.filter(alias => keep(alias));
    const remaining = [...person.globalAliases, ...Object.values(person.groups).flatMap(scope => scope.aliases)];
    if (!remaining.some(alias => alias.text === person.displayName)) person.displayName = remaining[0]?.text ?? '群友';
  }
  return doc;
}

// 撤回来源证据；旧无来源称呼清理本会话并撤销全局 learned 项，保留人工称呼及其他群本地称呼。
export function redactIdentityAliases(doc, key, messageId, removed = []) {
  doc.unresolved = (doc.unresolved ?? []).filter(item => item.conv !== key);
  for (const [qq, person] of Object.entries(doc.people ?? {})) {
    const revoked = new Set(removed.filter(item => item.kind === 'alias' && item.conv_id === key && item.subject_uid === qq).map(item => normalizeAliasText(item.content)));
    const touched = new Set();
    const keep = (alias, local) => {
      if (alias.source === 'manual') return true;
      if (alias.sources?.length) {
        const remaining = alias.sources.filter(item => item.conv !== key || item.id !== String(messageId));
        if (remaining.length === alias.sources.length) return true;
        touched.add(normalizeAliasText(alias.text));
        alias.sources = remaining;
        return remaining.length >= (alias.source === 'learned' ? 2 : 1);
      }
      const match = local && (['at', 'quote'].includes(alias.source) || (alias.source === 'learned' && revoked.has(normalizeAliasText(alias.text))));
      if (match) touched.add(normalizeAliasText(alias.text));
      return !match;
    };
    const group = key.startsWith('group:') ? person.groups?.[key.slice(6)] : null;
    if (group) group.aliases = group.aliases.filter(alias => keep(alias, true));
    person.globalAliases = (person.globalAliases ?? []).filter(alias => {
      if (alias.source === 'learned' && alias.sources?.length && alias.sources.every(item => item.conv.startsWith('group:'))
        && alias.sources.some(item => item.conv === key && item.id === String(messageId))) {
        const supporting = Object.values(person.groups ?? {}).filter(scope => scope.aliases.some(item => normalizeAliasText(item.text) === normalizeAliasText(alias.text)));
        alias.sources = supporting.flatMap(scope => scope.aliases.filter(item => normalizeAliasText(item.text) === normalizeAliasText(alias.text)).flatMap(item => item.sources ?? [])).slice(-64);
        touched.add(normalizeAliasText(alias.text));
        return supporting.length >= 3;
      }
      if (alias.sources?.length || key === `private:${qq}`) return keep(alias, true);
      if (alias.source !== 'learned' || !(revoked.has(normalizeAliasText(alias.text)) || touched.has(normalizeAliasText(alias.text)))) return true;
      // 无来源全局提升无法证明独立性：撤销全局项，其他群的本地称呼仍保留。
      return false;
    });
    const remaining = [...person.globalAliases, ...Object.values(person.groups ?? {}).flatMap(group => group.aliases)];
    if ([...revoked, ...touched].includes(normalizeAliasText(person.displayName)) && !remaining.some(alias => alias.text === person.displayName)) person.displayName = remaining[0]?.text ?? '群友';
  }
  return doc;
}

/** 撤销被删除或清空的别名记忆对应的学得身份副本（含衍生的全局晋升，保留人工与独立来源称呼）。 */
export function revokeIdentityAliases(doc, key, { removed = [], content, clearAll = false } = {}) {
  const groupId = key.startsWith('group:') ? key.slice(6) : null;
  const contentNorm = content !== undefined ? normalizeAliasText(content) : '';
  const unresolvedMatch = (text) => clearAll || (contentNorm && normalizeAliasText(text) === contentNorm)
    || removed.some((item) => item?.kind === 'alias' && (!item.conv_id || item.conv_id === key) && normalizeAliasText(item.content) === normalizeAliasText(text));
  const unresolvedBefore = (doc.unresolved ?? []).length;
  doc.unresolved = (doc.unresolved ?? []).filter((item) => !(item.conv === key && unresolvedMatch(item.text)));
  let changed = doc.unresolved.length !== unresolvedBefore;

  for (const [qq, person] of Object.entries(doc.people ?? {})) {
    const matchedItems = removed.filter((item) => item?.kind === 'alias' && (!item.conv_id || item.conv_id === key) && (!item.subject_uid || String(item.subject_uid) === qq));
    const itemTexts = new Set(matchedItems.map((item) => normalizeAliasText(item.content)).filter(Boolean));
    const directTexts = new Set([...itemTexts, ...(contentNorm ? [contentNorm] : [])]);
    // 按单条记忆 id 删除时仅作用于该条目 subject_uid；显式传 content 或清空整类时兜底撤销无池条目的残留副本。
    const scopeMatched = (alias) => {
      if (alias.source !== 'learned') return false;
      if (clearAll) return true;
      const norm = normalizeAliasText(alias.text);
      if (removed.length > 0 && content === undefined) return itemTexts.has(norm);
      return directTexts.has(norm);
    };

    const revokedTexts = new Set(itemTexts);
    const local = groupId != null ? person.groups?.[groupId] : null;
    if (local) {
      local.aliases = local.aliases.filter((alias) => {
        if (!scopeMatched(alias)) return true;
        revokedTexts.add(normalizeAliasText(alias.text));
        changed = true;
        return false;
      });
    }

    const nextGlobal = [];
    for (const alias of person.globalAliases ?? []) {
      const norm = normalizeAliasText(alias.text);
      const fromKey = Array.isArray(alias.sources) && alias.sources.some((item) => item.conv === key);
      const affected = alias.source === 'learned' && (
        revokedTexts.has(norm)
        || (fromKey && (clearAll || (removed.length > 0 && content === undefined ? itemTexts.has(norm) : directTexts.has(norm))))
        || (!alias.sources?.length && (key === `private:${qq}` && (clearAll || norm === contentNorm)))
      );
      if (!affected) { nextGlobal.push(alias); continue; }
      changed = true;
      if (!alias.sources?.length) continue;

      const remainingNonGroup = alias.sources.filter((item) => item.conv !== key && !item.conv.startsWith('group:'));
      const supportingGroups = Object.values(person.groups ?? {}).filter((scope) =>
        scope.aliases.some((item) => item.status === 'active' && normalizeAliasText(item.text) === norm));
      if (!remainingNonGroup.length && supportingGroups.length < 3) continue;

      const groupSources = supportingGroups.length >= 3
        ? supportingGroups.flatMap((scope) => scope.aliases.filter((item) => item.status === 'active' && normalizeAliasText(item.text) === norm).flatMap((item) => item.sources ?? []))
        : [];
      const merged = [];
      for (const evidence of [...remainingNonGroup, ...groupSources]) {
        if (!merged.some((item) => item.conv === evidence.conv && item.id === evidence.id)) merged.push(evidence);
      }
      alias.sources = merged.slice(-64);
      revokedTexts.add(norm);
      nextGlobal.push(alias);
    }
    person.globalAliases = nextGlobal;

    const remaining = [...person.globalAliases, ...Object.values(person.groups ?? {}).flatMap((scope) => scope.aliases)];
    const fallbackName = remaining.find((alias) => alias.status === 'active')?.text ?? remaining[0]?.text ?? '群友';
    const touchedNames = new Set([...revokedTexts, ...(contentNorm ? [contentNorm] : [])]);
    if (touchedNames.has(normalizeAliasText(person.displayName))
        && !remaining.some((alias) => normalizeAliasText(alias.text) === normalizeAliasText(person.displayName))) {
      if (person.displayName !== fallbackName) {
        person.displayName = fallbackName;
        changed = true;
      }
    }
  }
  return { doc, changed };
}
