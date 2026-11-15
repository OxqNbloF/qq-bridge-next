import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness();
const server = h.startConsoleServer();
const call = (method, pathname, body, headers = {}, target = server) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: target.address().port, path: pathname, method, headers: {
    'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers,
  } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});
const json = async (...args) => {
  const res = await call(...args);
  try { return { ...res, data: JSON.parse(res.text) }; }
  catch { throw new Error(`expected JSON, got ${res.status}: ${res.text}`); }
};

try {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  h.setMode('chat');
  const base = '/api/console/gate/member-policy';
  const empty = await json('GET', `${base}?group=456`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.entries, []);
  assert.equal(empty.data.mode, 'all');

  const put = await json('PUT', `${base}/456`, {
    expectedUpdatedAt: null,
    mode: 'blacklist',
    entries: [{ qq: '789', flags: { respond: false, converse: true, context: true, memory: true }, note: '刷屏' }],
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.data.entries[0].updatedBy, 'console');
  assert.equal(put.data.entries[0].effective.flags.respond, false);
  const file = path.join(h.temp, 'state', 'member-policy.json');
  const beforeConflict = fs.readFileSync(file);
  assert.equal((await json('PUT', `${base}/456`, { expectedUpdatedAt: null, mode: 'all', entries: [] })).status, 409);
  assert.deepEqual(fs.readFileSync(file), beforeConflict, '过期 CAS 不能改文件');
  assert.equal((await json('PUT', `${base}/456`, { mode: 'all', entries: [] })).status, 400, '整组替换必须提供 CAS 版本');

  const groupStamp = put.data.updatedAt;
  assert.equal((await json('PATCH', `${base}/456/members/789`, { expectedUpdatedAt: '1970-01-01T00:00:00.000Z', flags: { memory: false } })).status, 409, '过期 expectedUpdatedAt 的成员 PATCH 返回 409');
  assert.equal((await call('DELETE', `${base}/456/members/789?confirm=true&expectedUpdatedAt=1970-01-01T00:00:00.000Z`)).status, 409, '过期 expectedUpdatedAt 的成员 DELETE 返回 409');
  const patch = await json('PATCH', `${base}/456/members/789`, { expectedUpdatedAt: groupStamp, flags: { memory: false } });
  assert.equal(patch.status, 200, patch.text);
  assert.equal(patch.data.entries[0].flags.respond, false, '局部 PATCH 保留未修改的 flags');
  assert.equal(patch.data.entries[0].flags.memory, false);
  assert.notEqual(patch.data.updatedAt, groupStamp, '成员 PATCH 推进群级 CAS 版本');
  assert.equal((await json('PUT', `${base}/456`, { expectedUpdatedAt: groupStamp, mode: 'all', entries: [] })).status, 409, '成员 PATCH 后的旧群级版本不能覆盖规则');
  assert.equal((await json('PATCH', `${base}/456/members/789`, { unexpected: true })).status, 400, '成员 PATCH 拒绝未知字段');
  assert.equal((await json('GET', `${base}/effective?group=456&qq=789`)).data.flags.respond, false);
  assert.equal((await json('PATCH', `${base}/456/members/__proto__`, { flags: {} })).status, 400);

  const stamp = patch.data.updatedAt;
  const imported = { group: '456', expectedUpdatedAt: stamp, mode: 'whitelist', entries: [{ qq: '88', flags: {} }] };
  assert.equal((await json('POST', `${base}/import`, { ...imported, dryRun: true })).data.count, 1);
  assert.equal((await json('GET', `${base}?group=456`)).data.mode, 'blacklist', '预检不落盘');
  const committed = await json('POST', `${base}/import`, { ...imported, dryRun: false });
  assert.equal(committed.status, 200, committed.text);
  assert.equal(committed.data.mode, 'whitelist');
  const committedBytes = fs.readFileSync(file);
  const invalidImport = await json('POST', `${base}/import`, { ...imported, expectedUpdatedAt: committed.data.updatedAt, entries: [{ qq: '__proto__', flags: {} }], dryRun: true });
  assert.equal(invalidImport.status, 400);
  assert.equal((await json('POST', `${base}/import`, { ...imported, expectedUpdatedAt: committed.data.updatedAt, entries: [{ qq: '88', flags: { respond: true, converse: false } }], dryRun: true })).status, 400);
  const duplicateImport = await json('POST', `${base}/import`, { ...imported, expectedUpdatedAt: committed.data.updatedAt, entries: [{ qq: '88', flags: {} }, { qq: '88', flags: {} }], dryRun: true });
  assert.equal(duplicateImport.status, 400);
  const oversizedImport = await json('POST', `${base}/import`, { ...imported, expectedUpdatedAt: committed.data.updatedAt, entries: Array.from({ length: 5001 }, (_, index) => ({ qq: String(index + 1), flags: {} })), dryRun: true });
  assert.equal(oversizedImport.status, 400);
  assert.deepEqual(fs.readFileSync(file), committedBytes, '任何非法批次都不得部分写盘');

  const exported = await json('GET', `${base}/export?group=456`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.ok, true);
  assert.equal(exported.data.group, 'group:456');
  assert.ok(Array.isArray(exported.data.entries));
  const csv = await call('GET', `${base}/export?group=456&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /qq,respond,converse,context,memory,aliases,note/);
  assert.equal((await json('PATCH', `${base}/456/members/88`, { note: '=1+1' })).status, 400, '成员 PATCH 必须提供 expectedUpdatedAt');
  const noted = await json('PATCH', `${base}/456/members/88`, { note: '=1+1', expectedUpdatedAt: committed.data.updatedAt });
  assert.equal(noted.status, 200, noted.text);
  // 慢请求体期间发生并发写时，PATCH 也必须读体后再取快照并 409 拒绝（C-03）
  const slowPatch = new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: `${base}/456/members/88`,
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write('{"note":"stale"');
    setTimeout(async () => {
      await json('PATCH', `${base}/456/members/89`, { note: 'winner', expectedUpdatedAt: noted.data.updatedAt });
      req.end(`,"expectedUpdatedAt":${JSON.stringify(noted.data.updatedAt)}}`);
    }, 20);
  });
  const slowResult = await slowPatch;
  assert.equal(slowResult.status, 409, `slow body concurrent PATCH must 409: ${slowResult.text}`);
  const latestAfterSlow = (await json('GET', `${base}?group=456`)).data.updatedAt;
  const safeCsv = await call('GET', `${base}/export?group=456&format=csv`);
  assert.match(safeCsv.text, /'=1\+1/, 'CSV formula cells are neutralized');
  assert.equal((await call('DELETE', `${base}/456/members/88?confirm=true`)).status, 400, '成员 DELETE 必须提供 expectedUpdatedAt');
  const deleted = await call('DELETE', `${base}/456/members/88?confirm=true&expectedUpdatedAt=${encodeURIComponent(latestAfterSlow)}`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await call('DELETE', `${base}/456/members/789`)).status, 400, '成员删除必须明确确认');
  assert.notEqual((await json('GET', `${base}?group=456`)).data.updatedAt, committed.data.updatedAt, '成员 DELETE 推进群级 CAS 版本');
  assert.match(fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8'), /成员策略 group:456 成员 789|成员策略 group:456 删除成员 88/);
  assert.equal((await json('GET', `${base}?group=456`, undefined, { 'x-agent-call': '1' })).status, 403);
  assert.equal((await json('GET', `${base}?group=456`, undefined, { 'x-console-token': '' })).status, 401);
  const broken = await bridgeHarness({ config: { architecture: { gateV2: true } }, files: { 'state/member-policy.json': '{not json' } });
  const brokenServer = broken.startConsoleServer();
  try {
    if (!brokenServer.listening) await new Promise((resolve) => brokenServer.once('listening', resolve));
    const brokenFile = path.join(broken.temp, 'state', 'member-policy.json');
    const bytes = fs.readFileSync(brokenFile);
    assert.equal((await call('PUT', `${base}/456`, { expectedUpdatedAt: null, mode: 'all', entries: [] }, {}, brokenServer)).status, 503);
    assert.deepEqual(fs.readFileSync(brokenFile), bytes, '损坏策略只读，不能被写请求覆盖');
  } finally {
    await new Promise((resolve) => brokenServer.close(resolve));
    await broken.close();
  }
  console.log('PASS 门禁控制台 API：CAS、成员规则、导入预检、导出和鉴权');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
}
