// 黑话词库、身份别名隐私投影、媒体宽高嗅探与合并转发展开单测
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTermsStore } from '../src/features/terms.js';
import { createIdentityStore, memberRef } from '../src/features/identity.js';
import { sniffImage, validateImageBuffer } from '../src/features/media.js';
import { extractForwardIds, formatForwardNodes } from '../src/features/forward.js';

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('termsStore 按作用域隔离词条并拼装只读提示词块', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-terms-'));
  try {
    const terms = createTermsStore({ dataDir: dir, getConfig: () => ({ terms: { enabled: true, maxInject: 5 } }) });
    terms.save('global', { term: '典', meaning: '经典场面', scope: 'global' });
    terms.save('group:100', { term: '草', meaning: '好笑', scope: 'chat' });
    terms.save('group:200', { term: '秘', meaning: '仅200群可见', scope: 'chat' });

    const block100 = terms.buildPromptBlock('group:100');
    assert.equal(block100.includes('典'), true);
    assert.equal(block100.includes('草'), true);
    assert.equal(block100.includes('秘'), false);
    assert.equal(terms.search('group:100', '经典').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identityStore 自动归并昵称与别名，projectForModel 脱敏 QQ 并保留图片 Base64', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb3-id-'));
  try {
    const identity = createIdentityStore({
      dataDir: dir,
      getConfig: () => ({ identity: { enabled: true, learnFromChat: true, exposeQqInPrompt: false, maxAliasesPerUser: 8 } }),
    });
    identity.observe({ convKey: 'group:100', userId: '123456', nickname: '小张', card: '群友张' });
    identity.addAlias({ convKey: 'group:100', userId: '123456', alias: '张哥' });

    assert.equal(identity.resolveDisplayName('group:100', '123456'), '张哥');
    const b64 = 'A'.repeat(120);
    const projected = identity.projectForModel('group:100', {
      userId: '123456',
      text: '问一下 123456 晚上去不去',
      imagePayload: { type: 'image', base64: b64 },
    });
    assert.equal(projected.userId, undefined);
    assert.equal(projected.memberRef, memberRef('123456'));
    assert.equal(projected.text.includes('123456'), false);
    assert.equal(projected.text.includes('张哥'), true);
    assert.equal(projected.imagePayload.base64, b64, 'Base64 图片载荷不得被破坏');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('media 图片头嗅探、像素炸弹拦截与合并转发节点扁平化', () => {
  const smallPng = makePngBuffer(640, 480);
  const info = sniffImage(smallPng);
  assert.equal(info.format, 'png');
  assert.equal(info.width, 640);
  assert.equal(validateImageBuffer(smallPng, { maxBytes: 1024, maxPixels: 1000000 }).ok, true);

  const bombPng = makePngBuffer(10000, 10000);
  const bombCheck = validateImageBuffer(bombPng, { maxBytes: 1024, maxPixels: 1000000 });
  assert.equal(bombCheck.ok, false);
  assert.match(bombCheck.error, /像素/);

  assert.deepEqual(extractForwardIds([{ type: 'forward', data: { id: 'fwd-9' } }]), ['fwd-9']);
  const formatted = formatForwardNodes([
    {
      data: {
        name: '甲',
        content: [
          { type: 'text', data: { text: '看图' } },
          { type: 'image', data: { url: 'https://example.com/a.png' } },
          { type: 'forward', data: { content: [{ data: { name: '乙', content: '嵌套内容' } }] } },
        ],
      },
    },
  ]);
  assert.equal(formatted.lines[0].includes('嵌套转发'), true);
  assert.equal(formatted.media.length, 1);
});
