// 测 src/policy/ 里的纯函数：模式、白名单、审计工具
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModeInput, VALID_MODES, settingFromDshNamespace, normalizeReasoningEffort } from '../src/policy/mode.js';
import { normalizeOwnerQQ, normalizeIdList, ignoredSender, allowed, canonicalV2Key } from '../src/policy/access.js';
import {
  isSilentMarker, isSendToolName, hasTokenFragment, redactText, createAgentTokenRegistry,
  escapeCqText, unquoteJsonString, TOKEN_FRAGMENT_WIDTH,
} from '../src/policy/audit.js';

test('mode aliases collapse simulation into the internal reserved2 spelling', () => {
  assert.equal(normalizeModeInput(' simulation '), 'reserved2');
  assert.equal(normalizeModeInput('closed-agent'), 'closed-agent');
  assert.equal(normalizeModeInput('Reserved2'), null, 'case-sensitive: unknown spellings fail closed');
  assert.equal(normalizeModeInput(42), null);
  assert.deepEqual([...VALID_MODES].sort(), ['chat', 'closed-agent', 'reserved', 'reserved2']);
});

test('DSH settings read the user layer first (issue #22)', () => {
  assert.equal(settingFromDshNamespace({ user: { mode: 'chat' }, value: { mode: 'reserved2' } }, 'mode'), 'chat');
  assert.equal(settingFromDshNamespace({ user: {}, value: { mode: 'reserved2' } }, 'mode'), 'reserved2');
  assert.equal(settingFromDshNamespace({ user: [], value: null }, 'mode'), undefined);
  assert.equal(settingFromDshNamespace(null, 'mode'), undefined);
});

test('reasoning effort keeps adapter ids verbatim and recognises the none sentinel', () => {
  assert.equal(normalizeReasoningEffort(' NONE '), 'none');
  assert.equal(normalizeReasoningEffort('xHigh'), 'xHigh');
  assert.throws(() => normalizeReasoningEffort(''));
  assert.throws(() => normalizeReasoningEffort('max\u0007'));
});

test('ownerQQ / id lists accept only positive integers', () => {
  assert.equal(normalizeOwnerQQ(' 0123 '), 123);
  assert.equal(normalizeOwnerQQ(''), null);
  assert.throws(() => normalizeOwnerQQ('-1'));
  assert.throws(() => normalizeOwnerQQ('0'));
  assert.throws(() => normalizeOwnerQQ('9'.repeat(20)));
  assert.deepEqual(normalizeIdList([1, ' 2 ', 'x', -3]), ['1', '2']);
  assert.deepEqual(normalizeIdList('1'), []);
});

test('whitelist: deny wins, plural spelling works, empty allow falls back', () => {
  const cfg = { deny: { group: ['9'] }, allow: { groups: [1, '2'] }, allowAllWhenEmpty: false };
  assert.equal(allowed('group', 2, cfg), true);
  assert.equal(allowed('group', 3, cfg), false);
  assert.equal(allowed('group', '9', { ...cfg, allow: { groups: ['9'] } }), false);
  assert.equal(allowed('private', 5, { deny: {}, allow: {}, allowAllWhenEmpty: true }), true);
  assert.equal(ignoredSender('7', { ownerQQ: 1, ignore: { sendQQ: ['7'] } }), true);
  assert.equal(ignoredSender('1', { ownerQQ: 1, ignore: { sendQQ: ['1'] } }), false, 'owner is never ignored');
});

test('canonicalV2Key normalises leading zeros and rejects aliases', () => {
  assert.equal(canonicalV2Key('group:0456'), 'group:456');
  for (const bad of ['group:0', 'group:-1', 'guild:1', 'private:1.5', `group:${'9'.repeat(20)}`]) {
    assert.equal(canonicalV2Key(bad), null, bad);
  }
});

test('silent marker and send-tool detection', () => {
  assert.equal(isSilentMarker('  [silent] '), true);
  assert.equal(isSilentMarker('[SILENT] 但还有话'), false);
  assert.equal(isSendToolName('mcp__snowluma__qq_send_message'), true);
  assert.equal(isSendToolName('mcp__snowluma__qq_send_sticker'), false, 'stickers do not suppress text auto-forward');
});

test('split tokens are caught by 12-char windows; redaction covers whole tokens', () => {
  const token = 'a'.repeat(10) + '0123456789abcdef' + 'b'.repeat(6);
  assert.equal(hasTokenFragment(`前半段 ${token.slice(4, 4 + TOKEN_FRAGMENT_WIDTH)}`, [token]), true);
  assert.equal(hasTokenFragment(token.slice(0, TOKEN_FRAGMENT_WIDTH - 1), [token]), false);
  assert.equal(redactText(`x ${token} y`, [token], /C:\\Users\\[^\s]+/), 'x *** y');
  assert.equal(redactText('C:\\Users\\me\\a', [], /C:\\Users\\[^\s]+/), '***');
});

test('token registry keeps current + previous generation and never evicts live tokens', () => {
  const reg = createAgentTokenRegistry({ max: 3 });
  reg.remember('g:1', 't1'); reg.remember('g:1', 't2'); reg.remember('g:1', 't3');
  assert.deepEqual([...reg.known].sort(), ['t2', 't3'], 'third generation dropped');
  reg.remember('g:2', 'u1'); reg.remember('g:3', 'v1');
  assert.ok(reg.known.has('t3') && reg.known.has('u1') && reg.known.has('v1'), 'all live tokens retained');
  assert.ok(reg.known.size <= 4);
  reg.forget('g:1');
  assert.equal(reg.known.has('t3'), false);
  assert.equal(reg.byConversation.has('g:1'), false);
});

test('CQ escaping and JSON-string unquoting', () => {
  assert.equal(escapeCqText('[CQ:at,qq=1][cq:face]'), '[CQ：at,qq=1][CQ：face]');
  assert.equal(unquoteJsonString(' "你好" '), '你好');
  assert.equal(unquoteJsonString('"not json'), '"not json');
  assert.equal(unquoteJsonString(5), 5);
});
