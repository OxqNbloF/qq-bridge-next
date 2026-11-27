import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSettings } from '../src/config/schema.js';
import { checkImageBuffer, detectImageHeader } from '../src/features/attachments.js';
import { extractBundleIds, flattenBundleNodes } from '../src/features/bundle.js';
import { createMemberDirectory, memberTag } from '../src/features/directory.js';
import { createGlossaryVault } from '../src/features/glossary.js';

test('glossary vault isolates rooms and formats read-only prompt section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gloss-'));
  const cfg = parseSettings({ glossary: { enabled: true, maxInject: 5 } });
  const vault = createGlossaryVault({ dataDir: dir, getConfig: () => cfg });

  vault.put('', { term: 'GG', meaning: '游戏结束', scope: 'global' });
  vault.put('group:20001', { term: '上号', meaning: '开黑启动', scope: 'room' });
  vault.put('group:20002', { term: '隔离词', meaning: '别的群', scope: 'room' });

  const sec = vault.formatPromptSection('group:20001');
  assert.ok(sec.includes('GG: 游戏结束'));
  assert.ok(sec.includes('上号: 开黑启动'));
  assert.ok(!sec.includes('隔离词'));
});

test('member directory hashes raw IDs and preserves base64 images when sanitizing for model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dir-'));
  const cfg = parseSettings({ directory: { enabled: true, autoLearn: true, revealRawId: false } });
  const directory = createMemberDirectory({ dataDir: dir, getConfig: () => cfg });

  directory.observe({ roomId: 'group:20001', senderId: '555666', nickname: '老张', card: '群宠老张' });
  directory.addAlias({ roomId: 'group:20001', memberId: '555666', alias: '张总' });
  assert.equal(directory.displayNameFor('group:20001', '555666'), '张总');

  const bigB64 = 'A'.repeat(120);
  const sanitized = directory.sanitizeForModel('group:20001', {
    senderId: '555666',
    text: '找 555666 聊聊',
    media: { type: 'image', base64: bigB64 },
  });
  assert.equal(sanitized.senderId, undefined);
  assert.equal(sanitized.memberTag, memberTag('555666'));
  assert.equal(sanitized.text, '找 张总 聊聊');
  assert.equal(sanitized.media.base64, bigB64);
});

test('image sniff detects PNG/pixel-bombs and bundle unpack handles nested forward nodes', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(128, 16);
  png.writeUInt32BE(64, 20);
  assert.deepEqual(detectImageHeader(png), { format: 'png', mime: 'image/png', width: 128, height: 64 });
  assert.equal(checkImageBuffer(png, { maxPixels: 1000 }).ok, false);
  assert.equal(checkImageBuffer(png, { maxPixels: 20000 }).ok, true);

  assert.deepEqual(extractBundleIds([{ type: 'forward', data: { id: 'b-1' } }]), ['b-1']);
  const flat = flattenBundleNodes([
    { data: { name: 'A', content: [{ type: 'text', data: { text: '一层' } }, { type: 'forward', data: { content: [{ data: { name: 'B', content: '二层' } }] } }] } },
  ], { maxDepth: 2 });
  assert.ok(flat.lines[0].includes('二层'));
});
