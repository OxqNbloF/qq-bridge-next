import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyIdentityDocument, recordObservedAlias, recordUnresolvedAlias, resolveAlias, validateIdentityDocument } from '../src/identity/registry.js';
import { canonicalV2Key } from '../src/policy/access.js';
import { atomicWriteJson } from '../src/store/fs-atomic.js';
import { stampSchema } from '../src/store/schema.js';

// 默认只读预检；只为尚无 identity.json 的安装建立初始身份表。
export function migrateIdentity({ stateDir, apply = false }) {
  const target = path.join(stateDir, 'identity.json');
  const existing = fs.existsSync(target);
  const doc = existing ? validateIdentityDocument(JSON.parse(fs.readFileSync(target, 'utf8'))) : emptyIdentityDocument();
  const report = { files: 0, observations: 0, rejected: 0, people: 0, resolved: 0, unresolved: 0, applied: false };
  const observe = (key, qq, name) => {
    if (!qq || !name) return;
    try {
      recordObservedAlias(doc, { qq: String(qq), group: key.startsWith('group:') ? key.slice(6) : null, name: String(name), source: key.startsWith('group:') ? 'card' : 'nickname' });
      report.observations++;
    } catch { report.rejected++; }
  };
  const archive = path.join(stateDir, 'archive');
  if (fs.existsSync(archive)) for (const folder of fs.readdirSync(archive, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(group|private)_\d+$/.test(entry.name))) {
    const key = canonicalV2Key(folder.name.replace('_', ':'));
    for (const file of fs.readdirSync(path.join(archive, folder.name)).filter(name => /\.jsonl$/.test(name))) {
      report.files++;
      const rows = fs.readFileSync(path.join(archive, folder.name, file), 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { report.rejected++; return []; }
      });
      for (const row of rows) {
        if (row.v > 1) throw new Error('存档版本过新，拒绝迁移');
        if (!row.redacted && !row.recalled && row.from !== 'bot' && canonicalV2Key(row.conv_id) === key) observe(key, row.user_id, row.nick);
      }
    }
  }
  const socialFile = path.join(stateDir, 'social-v2.json');
  const social = fs.existsSync(socialFile) ? JSON.parse(fs.readFileSync(socialFile, 'utf8')) : {};
  if (social.schemaVersion > 1) throw new Error('会话状态版本过新，拒绝迁移');
  for (const [rawKey, state] of Object.entries(social.conversations ?? {})) {
    const key = canonicalV2Key(rawKey);
    if (!key) continue;
    for (const message of state.recentMessages ?? []) if (!message.isSelf) observe(key, message.userId, typeof message.sender === 'string' ? message.sender : message.sender?.displayName);
  }
  for (const [key, state] of Object.entries(social.conversations ?? {})) {
    if (!canonicalV2Key(key)) continue;
    for (const name of Object.keys(state.memberImpressions ?? {})) {
      const result = resolveAlias(doc, { group: key.startsWith('group:') ? key.slice(6) : null, text: name });
      if (result?.qq) report.resolved++;
      else { recordUnresolvedAlias(doc, { conv: key, text: name }); report.unresolved++; }
    }
  }
  const poolFile = path.join(stateDir, 'pool', 'items.jsonl');
  if (fs.existsSync(poolFile)) for (const line of fs.readFileSync(poolFile, 'utf8').split('\n').filter(Boolean)) {
    let item;
    try { item = JSON.parse(line); } catch { report.rejected++; continue; }
    if (item.schemaVersion > 2) throw new Error('记忆池版本过新，拒绝迁移');
    if (item.kind !== 'impression' || !canonicalV2Key(item.conv_id)) continue;
    const name = String(item.subject_uid ?? '').replace(/^legacy:/, '');
    const result = resolveAlias(doc, { group: item.conv_id.startsWith('group:') ? item.conv_id.slice(6) : null, text: name });
    if (result?.qq) report.resolved++;
    else if (name) { recordUnresolvedAlias(doc, { conv: item.conv_id, text: name }); report.unresolved++; }
  }
  report.people = Object.keys(doc.people).length;
  if (existing) return { ...report, existing: true, reason: '已预检历史数据；保留现有身份表，未覆盖' };
  if (apply) {
    atomicWriteJson(target, stampSchema('identity', validateIdentityDocument(doc)));
    report.applied = true;
    atomicWriteJson(path.join(stateDir, 'identity-migration.json'), report);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv.find(value => value.startsWith('--state='))?.slice(8) ?? fileURLToPath(new URL('../state', import.meta.url));
  console.log(JSON.stringify(migrateIdentity({ stateDir, apply: process.argv.includes('--apply') }), null, 2));
}
