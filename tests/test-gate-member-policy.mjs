// 门禁纯函数：四开关归一化、名单模式 × 16 组合 × 群/私聊、边界与 fail-closed
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, normalizeFlags, conversationGate, FLAG_KEYS, DEFAULT_FLAGS, MEMBER_MODES } from '../src/gate/decide.js';

const cfg = { ownerQQ: 1, allow: {}, deny: {}, allowAllWhenEmpty: true };
const combos = Array.from({ length: 16 }, (_, n) => Object.fromEntries(FLAG_KEYS.map((k, i) => [k, !!(n & (1 << i))])));
const NONE = { respond: false, converse: false, context: false, memory: false };

test('normalizeFlags: 16 组合都满足两条约束，合法组合原样保留', () => {
  for (const f of combos) {
    const n = normalizeFlags(f);
    assert.ok(!n.respond || n.converse, JSON.stringify(f));
    assert.ok(n.converse || n.memory || !n.context, JSON.stringify(f));
    const legal = (!f.respond || f.converse) && (f.converse || f.memory || !f.context);
    if (legal) assert.deepEqual(n, f);
  }
  assert.deepEqual(normalizeFlags({ respond: true, converse: false, context: true, memory: true }),
    { respond: false, converse: false, context: true, memory: true }, '仅背景记忆');
  assert.deepEqual(normalizeFlags(undefined), DEFAULT_FLAGS);
  assert.deepEqual(normalizeFlags({ memory: 'false' }), { ...DEFAULT_FLAGS, memory: false }, '写了但不是 true 当 false');
});

test('主矩阵：3 名单模式 × 16 组合 × 群/私聊', () => {
  for (const mode of MEMBER_MODES) {
    for (const flags of combos) {
      const policy = { groups: { 'group:789': { mode, rules: { 5: { qq: '5', flags, note: 'n' } } } }, private: { 5: flags } };
      const inRule = decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'reserved2', policy });
      const noRule = decide({ kind: 'group', id: 789, qq: 6, cfg, mode: 'reserved2', policy });
      assert.equal(inRule.gate.memberMode, mode);
      if (mode === 'blacklist') {
        assert.deepEqual([inRule.allowed, inRule.reason, inRule.flags], [false, 'blacklisted', NONE]);
        assert.deepEqual([noRule.allowed, noRule.flags], [true, DEFAULT_FLAGS]);
      } else {
        assert.deepEqual([inRule.allowed, inRule.flags], [true, normalizeFlags(flags)]);
        assert.deepEqual(inRule.gate.rule, { qq: 5, note: 'n' });
        if (mode === 'whitelist') assert.deepEqual([noRule.allowed, noRule.reason], [false, 'not-in-whitelist']);
        else assert.deepEqual([noRule.allowed, noRule.flags], [true, DEFAULT_FLAGS]);
      }
      const priv = decide({ kind: 'private', id: 5, qq: 5, cfg, mode: 'chat', policy });
      assert.deepEqual([priv.allowed, priv.flags], [true, normalizeFlags(flags)], '私聊走 private 段，与群名单模式无关');
    }
  }
});

test('会话白名单与模式权限：deny 优先、allowAllWhenEmpty、closed-agent 仅 owner 私聊', () => {
  const strict = { ownerQQ: 1, allow: { group: ['789'] }, deny: { group: ['9'] }, allowAllWhenEmpty: false };
  assert.equal(decide({ kind: 'group', id: 789, qq: 5, cfg: strict, mode: 'chat' }).allowed, true);
  assert.equal(decide({ kind: 'group', id: 9, qq: 5, cfg: strict, mode: 'chat' }).reason, 'conv-denied');
  assert.equal(decide({ kind: 'private', id: 5, qq: 5, cfg: strict, mode: 'chat' }).reason, 'conv-denied');
  assert.equal(decide({ kind: 'private', id: 1, qq: 1, cfg: strict, mode: 'closed-agent' }).allowed, true, '与现状一致：不查白名单');
  assert.equal(decide({ kind: 'private', id: 5, qq: 5, cfg, mode: 'closed-agent' }).reason, 'mode-denied');
  assert.equal(decide({ kind: 'group', id: 789, qq: 1, cfg, mode: 'closed-agent' }).reason, 'mode-denied');
});

test('owner 保留管理入口与 ignore 豁免，但遵守上下文和记忆隐私策略', () => {
  const policy = { groups: { 'group:789': { mode: 'whitelist', rules: {} } }, private: { 1: NONE } };
  const ig = { ...cfg, ignore: { sendQQ: ['1', '7'] } };
  assert.deepEqual(decide({ kind: 'group', id: 789, qq: 1, cfg: ig, mode: 'chat', policy }).flags, DEFAULT_FLAGS);
  assert.deepEqual(decide({ kind: 'private', id: 1, qq: 1, cfg: ig, mode: 'chat', policy }).flags, { ...DEFAULT_FLAGS, context: false, memory: false });
  const groupPolicy = { groups: { 'group:789': { mode: 'blacklist', rules: { 1: { flags: NONE } } } } };
  const owner = decide({ kind: 'group', id: 789, qq: 1, cfg: ig, mode: 'chat', policy: groupPolicy });
  assert.equal(owner.allowed, true);
  assert.deepEqual(owner.flags, { ...DEFAULT_FLAGS, context: false, memory: false });
  assert.deepEqual(decide({ kind: 'private', id: 1, qq: 1, cfg: ig, mode: 'chat', policy, applyMemberPolicy: false }).flags, DEFAULT_FLAGS);
  assert.equal(decide({ kind: 'group', id: 789, qq: 7, cfg: ig, mode: 'chat' }).reason, 'ignored');
  assert.deepEqual(decide({ kind: 'group', id: 789, qq: 7, cfg, mode: 'chat', applyMemberPolicy: false, policy: { groups: { 'group:789': { mode: 'whitelist', rules: {} } } } }).flags, DEFAULT_FLAGS, '关闭 gateV2 时只保留会话与忽略判定');
});

test('运行时开关：静默只放行 owner；暂停只拦 AI 回复', () => {
  assert.equal(decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'chat', runtime: { silent: true } }).reason, 'silent');
  assert.equal(decide({ kind: 'group', id: 789, qq: 1, cfg, mode: 'chat', runtime: { silent: true } }).allowed, true);
  assert.equal(decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'reserved2', runtime: { paused: true } }).allowed, true);
  assert.equal(decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'reserved2', runtime: { paused: true, aiReply: true } }).reason, 'paused');
});

test('fail-closed：策略损坏/未知名单模式不回应；坏 qq 与原型键拒绝', () => {
  const broken = decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'chat', policyBroken: true });
  assert.deepEqual([broken.reason, broken.flags.respond], ['policy-broken', false]);
  const odd = decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'chat', policy: { groups: { 'group:789': { mode: 'allow-all', rules: {} } } } });
  assert.equal(odd.flags.respond, false);
  for (const qq of ['__proto__', 'constructor', '', null, '0', '-1', '5 ']) {
    assert.equal(decide({ kind: 'group', id: 789, qq, cfg, mode: 'chat', policy: { groups: { 'group:789': { mode: 'blacklist', rules: {} } } } }).reason, 'bad-sender', String(qq));
  }
  const wl = { groups: { 'group:789': { mode: 'whitelist', rules: {} } } };
  assert.equal(decide({ kind: 'group', id: 789, qq: 5, cfg, mode: 'chat', policy: wl }).allowed, false, '继承来的键不算规则');
});

test('conversationGate：旧语义（closed-agent 不查白名单；listed 时也查白名单）', () => {
  const strict = { ownerQQ: 1, allow: { private: ['2'] }, deny: {}, allowAllWhenEmpty: false };
  const g = (o) => conversationGate({ kind: 'private', id: 1, cfg: strict, ...o });
  assert.equal(g({ mode: 'chat' }), 'conv-denied');
  assert.equal(g({ mode: 'chat', id: 2 }), null);
  assert.equal(g({ mode: 'closed-agent', closedAgentOk: false }), 'mode-denied');
  assert.equal(g({ mode: 'closed-agent', closedAgentOk: true }), null, '旧行为：closed-agent 不查白名单');
  assert.equal(g({ mode: 'closed-agent', closedAgentOk: true, listed: true }), 'conv-denied');
});
