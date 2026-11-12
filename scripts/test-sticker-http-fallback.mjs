// 测表情同步：WebSocket 挂了就改走 HTTP 接口
// WebSocket 正常时仍走它，不多打一次 HTTP
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
// 跑一条检查，失败就记一次并打印
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 假装 WS 挂掉的客户端：一请求就报错
class WsDownBot {
  onPrivateMessage() {}
  onGroupMessage() {}
  onNotice() {}
  onEvent() {}
  onEventError() {}
  async request() { throw new Error('SnowLuma WebSocket closed before opening'); }
  async getImage() { return null; }
  async fetchFaceEntity() { return null; }
  async sendPrivateMessage() {}
  async sendGroupMessage() {}
  async connect() {}
  close() {}
}

// 假装 WS 正常的客户端：返回一个收藏表情
class WsUpBot extends WsDownBot {
  async request(action) {
    if (action === 'fetch_custom_face_detail') {
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'ws-fixture-sticker', resId: 'ws-fixture-sticker', url: 'https://public.invalid/ws-sticker', md5: '11223344556677889900AABBCCDDEEFF', desc: 'WS 表情' }] };
    }
    return { status: 'ok', retcode: 0, data: {} };
  }
}

// 只挑出查收藏表情详情的那些 HTTP 请求
const httpCalls = (h) => h.calls.http.filter((c) => String(c.url).endsWith('/fetch_custom_face_detail'));

await test('WS 正常时走 WS，不额外打 HTTP', async () => {
  const h = await bridgeHarness({ globals: { SnowLumaWebSocketClient: WsUpBot } });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.ok(synced, '同步应当成功');
    assert.equal(synced.via, 'ws');
    assert.equal(synced.entries.length, 1);
    assert.equal(synced.entries[0].id, 'ws-fixture-sticker');
    assert.equal(httpCalls(h).length, 0, 'WS 成功时不该再打 HTTP（不增加正常路径延迟）');
  } finally { await h.close(); }
});

await test('WS 挂了自动改走 OneBot HTTP，结果标 via=http', async () => {
  const h = await bridgeHarness({ globals: { SnowLumaWebSocketClient: WsDownBot } });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.ok(synced, 'WS 失败时必须有兜底，而不是整条链路失败');
    assert.equal(synced.via, 'http');
    assert.equal(synced.entries.length, 1);
    assert.equal(synced.entries[0].id, 'http-fixture-sticker');
    assert.equal(synced.entries[0].desc, 'HTTP 兜底表情');
    const calls = httpCalls(h);
    assert.equal(calls.length, 1, '应当只打一次 HTTP');
    assert.deepEqual(calls[0].body, { count: 100 }, '要带上与 WS 路径相同的参数');
  } finally { await h.close(); }
});

await test('HTTP 兜底也失败时仍然返回 null（不炸、不清空本地库）', async () => {
  const h = await bridgeHarness({
    globals: {
      SnowLumaWebSocketClient: WsDownBot,
      // 覆盖测试工具的通用 fetch：让 HTTP 口也连不上
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3000'); }
    }
  });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.equal(synced, null, '两条路都失败时按原约定返回 null（调用方用缓存）');
  } finally { await h.close(); }
});

await test('HTTP 返回的不是数组时不合并（防拿坏数据清空表情库）', async () => {
  const h = await bridgeHarness({
    globals: {
      SnowLumaWebSocketClient: WsDownBot,
      // 覆盖通用 fetch：让 HTTP 退路返回对象而不是数组
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', retcode: 0, data: { not: 'an array' } })
      })
    }
  });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.equal(synced, null);
  } finally { await h.close(); }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
