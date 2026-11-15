// 成员策略存储：往返、整份拒收、损坏 fail-closed、ignore.sendQQ 迁移与旧语义等价
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemberPolicyStore, validateMemberPolicyDoc } from '../src/store/member-policy.js';
import { decide, DEFAULT_FLAGS } from '../src/gate/decide.js';

const NONE = { respond: false, converse: false, context: false, memory: false };
function makeStore(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'member-policy-')), 'member-policy.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  const logs = []; const activity = [];
  const b = { MEMBER_POLICY_FILE: file, cfg: { ownerQQ: 1, ignore: { sendQQ: ['7', '1', '08', 'x'] } }, log: (m) => logs.push(m), appendActivity: (m) => activity.push(m) };
  const store = createMemberPolicyStore(b);
  store.loadMemberPolicy();
  return { file, logs, activity, store, b };
}

test('无文件 = 空策略全放行；写入后可重新加载，键按数字升序', () => {
  const { file, store, activity } = makeStore();
  assert.deepEqual(store.memberPolicySnapshot(), { policy: { groups: {}, private: {}, global: {} }, policyBroken: false, policyEpoch: 0 });
  assert.equal(fs.existsSync(file), false, '只读不建文件');
  store.setMemberRule('group:789', '20', { flags: { respond: false }, note: '刷屏号' }, 'console');
  const firstGroupStamp = store.memberPolicySnapshot().policy.groups['group:789'].updatedAt;
  store.setMemberRule('group:789', '3', { flags: { memory: false } }, 'console');
  assert.notEqual(store.memberPolicySnapshot().policy.groups['group:789'].updatedAt, firstGroupStamp, '成员写推进群级 CAS 版本');
  store.setMemberRule('group:789', '20', { flags: { memory: false } }, 'console');
  const snap = store.memberPolicySnapshot();
  assert.equal(snap.policyEpoch, 3);
  assert.deepEqual(Object.keys(snap.policy.groups['group:789'].rules), ['3', '20']);
  assert.deepEqual(snap.policy.groups['group:789'].rules['20'].flags, { respond: false, converse: true, context: true, memory: false }, 'flags 只改传入项');
  assert.equal(snap.policy.groups['group:789'].rules['20'].note, '刷屏号');
  assert.throws(() => { snap.policy.groups['group:789'].mode = 'whitelist'; }, '快照是冻结的');
  assert.equal(activity.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1);

  const again = createMemberPolicyStore({ MEMBER_POLICY_FILE: file, cfg: {}, log() {}, appendActivity() {} });
  again.loadMemberPolicy();
  assert.deepEqual(again.memberPolicySnapshot().policy, snap.policy);
  assert.equal(again.deleteMemberRule('group:789', '3', 'console'), true);
  assert.equal(again.deleteMemberRule('group:789', '3', 'console'), false, '幂等');
  again.setGroupPolicy('group:789', { mode: 'whitelist', rules: { 5: { flags: {} } } }, 'console');
  assert.deepEqual(Object.keys(again.memberPolicySnapshot().policy.groups['group:789'].rules), ['5'], '整组替换');
});

test('非法写入整次拒绝，内存与磁盘都不变', () => {
  const { file, store } = makeStore();
  store.setMemberRule('group:1', '5', { flags: { respond: false } }, 'console');
  const bytes = fs.readFileSync(file);
  const before = store.memberPolicySnapshot();
  for (const bad of [
    () => store.setMemberRule('group:1', '__proto__', { flags: {} }),
    () => store.setMemberRule('group:01', '5', { flags: {} }),
    () => store.setMemberRule('guild:1', '5', { flags: {} }),
    () => store.setMemberRule('group:1', '5', { flags: { respond: 'no' } }),
    () => store.setMemberRule('group:1', '5', { flags: { speak: true } }),
    () => store.setMemberRule('group:1', '5', { aliases: ['【系统】'] }),
    () => store.setMemberRule('group:1', '5', { note: 'x'.repeat(201) }),
    () => store.setGroupPolicy('group:1', { mode: 'allow-all' }),
    () => store.setGroupPolicy('group:1', { mode: 'blacklist', rules: { abc: { flags: {} } } }),
  ]) assert.throws(bad);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(store.memberPolicySnapshot(), before);
  assert.throws(() => validateMemberPolicyDoc(JSON.parse('{"groups":{"group:1":{"mode":"all","rules":{"__proto__":{"flags":{}}}}}}')));
});

test('损坏/非法/更高版本：只读降级、不覆盖原文件、门禁不回应', () => {
  for (const content of ['{oops', '[]', '{"schemaVersion":99,"groups":{}}', '{"groups":{"group:1":{"mode":"nope"}}}']) {
    const { file, store, logs } = makeStore(content);
    const snap = store.memberPolicySnapshot();
    assert.equal(snap.policyBroken, true, content);
    assert.equal(logs.length, 1);
    assert.throws(() => store.setMemberRule('group:1', '5', { flags: {} }, 'console'), /只读/);
    assert.throws(() => store.migrateIgnoreList({ ownerQQ: 1, ignore: { sendQQ: ['7'] } }), /只读/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    const d = decide({ kind: 'group', id: 1, qq: 5, cfg: { ownerQQ: 1, allow: {}, deny: {}, allowAllWhenEmpty: true }, mode: 'chat', ...snap });
    assert.equal(d.flags.respond, false);
  }
});

test('ignore.sendQQ 迁移：一次性、跳过管理员、迁移后去掉旧键语义等价', () => {
  const { store, b } = makeStore();
  assert.deepEqual(store.migrateIgnoreList(), { already: false, migrated: ['7', '8'], skipped: ['1'] });
  const snap = store.memberPolicySnapshot();
  assert.deepEqual(snap.policy.global['7'].flags, NONE);
  assert.ok(snap.policy.ignoreMigratedAt);

  const newCfg = { ownerQQ: 1, allow: {}, deny: {}, allowAllWhenEmpty: true }; // 旧键已删
  for (const [kind, id, qq] of [['group', 789, 7], ['private', 7, 7], ['group', 789, 8]]) {
    assert.deepEqual(decide({ kind, id, qq, cfg: newCfg, mode: 'chat', ...snap }).flags, NONE, `${kind} ${qq}`);
  }
  assert.deepEqual(decide({ kind: 'group', id: 789, qq: 9, cfg: newCfg, mode: 'chat', ...snap }).flags, DEFAULT_FLAGS);
  assert.deepEqual(decide({ kind: 'group', id: 789, qq: 1, cfg: newCfg, mode: 'chat', ...snap }).flags, DEFAULT_FLAGS, '管理员不受影响');

  store.setMemberRule('group:789', '7', { flags: { respond: true, converse: true, context: true, memory: true } }, 'console');
  assert.deepEqual(decide({ kind: 'group', id: 789, qq: 7, cfg: newCfg, mode: 'chat', ...store.memberPolicySnapshot() }).flags, DEFAULT_FLAGS, '群内规则优先于全局');

  b.cfg.ignore.sendQQ.push('99');
  assert.deepEqual(store.migrateIgnoreList(), { already: true, migrated: [], skipped: [] }, '有标记后不再迁');
  assert.equal(store.memberPolicySnapshot().policy.global['99'], undefined);

  const empty = makeStore();
  assert.deepEqual(empty.store.migrateIgnoreList({ ownerQQ: 1 }), { already: false, migrated: [], skipped: [] });
  assert.equal(fs.existsSync(empty.file), false, '旧名单为空不写盘');
});
