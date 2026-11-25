import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText } from '../store/fs-atomic.js';
import { migrateDocument } from '../store/schema.js';
import { LIGHT_MEMORY_KINDS } from './light.js';

// 无来源的历史派生记忆只能保守处理；明确来源的无关条目保留。
function usesSource(item, key, messageId) {
  if (!item || typeof item !== 'object') return false;
  const ids = Array.isArray(item.source_msg_ids) ? item.source_msg_ids : [];
  // 消息号按会话隔离；全局派生项也必须核对来源，不能被范围判断提前跳过。
  if (ids.map(String).includes(String(messageId)) && [key, 'global'].includes(item.conv_id)) return true;
  if ([key, 'global'].includes(item.conv_id) && item.evidence != null) {
    const evidence = evidenceUsesSource(item.evidence, key, messageId);
    if (evidence !== null) return evidence;
  }
  if (ids.length) return false;
  if (item.conv_id !== key && item.conv_id !== 'global') return false;
  return (LIGHT_MEMORY_KINDS.includes(item.kind) || ['term', 'slang'].includes(item.kind)) && (item.data?.source ?? item.source) !== 'manual';
}

function evidenceUsesSource(value, key, messageId) {
  if (Array.isArray(value)) {
    const matches = value.map(entry => evidenceUsesSource(entry, key, messageId));
    // 只有全部证据都能归因且无关，才能据此保留；未知项不能被无关项掩盖。
    return matches.includes(true) ? true : !matches.length || matches.includes(null) ? null : false;
  }
  // 旧 evidence 也可能只是原文；无法识别来源时仍走保守清理。
  if (!value || typeof value !== 'object') return value != null && String(value) === String(messageId) ? true : null;
  const conv = value.conv_id ?? value.conv ?? value.scope;
  if (conv && conv !== key && conv !== 'global') return false;
  const ids = [value.messageId, value.message_id, value.msgId, value.msg_id, value.id,
    ...[value.source_msg_ids, value.sourceMessageIds, value.message_ids].flatMap(ids => Array.isArray(ids) ? ids : [])]
    .filter(id => id != null);
  return ids.length ? ids.some(id => String(id) === String(messageId)) : null;
}

export function redactMemoryPool(pool, key, messageId) {
  const removed = [];
  pool.update(items => items.filter(item => {
    if (!usesSource(item, key, messageId)) return true;
    removed.push(item);
    return false;
  }));
  return removed;
}

export function redactLightMemory(state, messageId) {
  const keep = item => item?.sourceMessageIds?.length && !item.sourceMessageIds.map(String).includes(String(messageId));
  for (const field of ['activeTopics', 'pendingThoughts']) state[field] = (state[field] ?? []).filter(keep);
  state.memberImpressions = Object.fromEntries(Object.entries(state.memberImpressions ?? {}).filter(([, item]) => keep(item)));
}

// 无来源号的旧日志只保留时间和会话占位；带来源号的新日志只删目标消息。
export function redactActivityLog(file, key, messageId) {
  const escapedKey = String(key ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] (?:\\[msg:[^\\]]*\\] )?${escapedKey}(?=\\s|（|$)`);
  for (const target of [file, `${file}.1`]) {
    let text;
    try { text = fs.readFileSync(target, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const kept = text.replace(/^\uFEFF/, '').split('\n').map(line => {
      if (!match.test(line)) return line;
      const source = /^\[\d{2}:\d{2}:\d{2}\] \[msg:([^\]]*)\] /.exec(line);
      if (source) return source[1] === encodeURIComponent(String(messageId)) ? null : line;
      return line.match(match)[0] + ' [隐私删除：无来源日志正文已脱敏]';
    }).filter(line => line !== null).join('\n');
    if (kept !== text) atomicWriteText(target, kept);
  }
}


// 可解析备份按会话/来源清理；坏格式或未来版本无法安全理解时只移除该份备份。
export function redactMemoryMigrationBackups(stateDir, key, messageId) {
  const errors = [];
  for (const name of ['social-v2.json.bak-identity-memory', 'pool/items.jsonl.bak-identity-memory', 'pool/items.jsonl.bak-terms-v2', 'slang.json.bak-terms-v2']) {
    const file = path.join(stateDir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${name} 读取失败：${error.message}`);
      continue;
    }
    let next;
    try {
      const cleanText = text.replace(/^\uFEFF/, '');
      if (name.startsWith('social-v2')) {
        const doc = JSON.parse(cleanText);
        migrateDocument('social-v2', doc);
        if (!doc.conversations || typeof doc.conversations !== 'object' || Array.isArray(doc.conversations)) throw new Error('备份缺少会话表');
        const state = doc.conversations[key];
        if (state && typeof state === 'object') {
          redactLightMemory(state, messageId);
          for (const field of ['recentMessages', 'unread']) {
            if (Array.isArray(state[field])) state[field] = state[field].filter(item => String(item.messageId) !== String(messageId));
          }
        }
        next = JSON.stringify(doc, null, 2) + '\n';
      } else if (name.startsWith('slang')) {
        const items = JSON.parse(cleanText);
        if (!Array.isArray(items)) throw new Error('旧词汇备份不是数组');
        next = JSON.stringify(items.filter(item => {
          if (!item || typeof item !== 'object') return true;
          return !usesSource({ ...item, kind: 'slang', conv_id: item.scope ?? item.conv_id ?? 'global' }, key, messageId);
        }), null, 2) + '\n';
      } else {
        const lines = cleanText.split('\n').filter(line => line.trim());
        next = lines.filter(line => {
          const item = JSON.parse(line);
          if (item && Object.hasOwn(item, 'schemaVersion') && !item.id) { migrateDocument('pool', item); return true; }
          return !usesSource(item, key, messageId);
        }).join('\n') + '\n';
      }
    } catch (error) {
      try {
        fs.rmSync(file, { force: true });
        errors.push(`${name} 无法安全解析，已移除该备份：${error.message}`);
      } catch (removeError) {
        errors.push(`${name} 无法安全解析：${error.message}；移除失败：${removeError.message}`);
      }
      continue;
    }
    try { if (next !== text) atomicWriteText(file, next); }
    catch (error) { errors.push(`${name} 写入失败：${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join('；'));
}
