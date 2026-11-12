// 检查控制台各分组里的路由有没有被正确接上。
// 真的逐个请求一遍，只要不是「没找到」就算接上了。
// 会换令牌、会让程序退出的两个接口跳过不测。
// 没令牌会被拦下，乱写的路径仍然返回「没找到」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 所有路由分组所在的文件夹
const GROUP_DIRS = [
  path.join('src', 'features', 'console', 'routes'),
  path.join('src', 'features', 'tools', 'http-face'),
  path.join('src', 'features', 'usage'),
];
const routes = [];
const groupFiles = GROUP_DIRS.flatMap((d) => {
  const dir = path.join(ROOT, d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(d, f)) : [];
});
for (const file of groupFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (!src.includes('ROUTE_NEXT')) continue; // 不是路由分组的文件就跳过
  for (const m of src.matchAll(/rq\.req\.method === '(GET|POST)' && rq\.url\.pathname === '(\/[^']*)'/g)) {
    routes.push({ file, method: m[1], path: m[2] });
  }
}
assert.ok(routes.length >= 80, `只解析到 ${routes.length} 条路由，正则可能失配`);

const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
const server = h.startConsoleServer();
let failures = 0;
// 请求一次本地接口，拿回状态码和内容
const call = (method, pathname, { token = 'fixture-console-token', body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) } }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  req.end(body === undefined ? undefined : JSON.stringify(body));
});
try {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  h.setMode('reserved2');
  const seen = new Set();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 换令牌和会让程序退出的两个接口不在这里测
    if (r.method === 'POST' && (r.path === '/api/console/token' || r.path === '/api/restart')) continue;
    try {
      const res = await call(r.method, r.path, r.method === 'POST' ? { body: [] } : {});
      const notFound = res.status === 404 && res.json?.error === 'not found';
      assert.equal(notFound, false, `${key}（${r.file}）落到了 404 兜底`);
      console.log(`PASS ${key} → ${res.status}（${r.file}）`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${key}:`, error.message);
    }
  }
  const unauth = await call('GET', '/api/sessions', { token: '' });
  assert.equal(unauth.status, 401, '鉴权必须仍在分发之前');
  const missing = await call('GET', '/api/definitely-not-a-route');
  assert.deepEqual([missing.status, missing.json?.error], [404, 'not found']);
  console.log('PASS 鉴权在分发之前；未知路径仍是 404');
  // 切换模式要真的改到桥接里的当前模式
  const modeRes = await call('POST', '/api/mode', { body: { mode: 'chat' } });
  assert.equal(modeRes.status, 200, JSON.stringify(modeRes.json));
  assert.equal(h.getMode(), 'chat', '/api/mode 必须写到桥接的 currentMode');
  // 重置状态要走统一入口，存盘时要带上版本号
  const reset = await call('POST', '/api/socialV2/reset', { body: {} });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  assert.ok(Number.isInteger(saved.schemaVersion) && saved.paused === false, JSON.stringify(saved));
  assert.deepEqual(saved.conversations, {});
  console.log('PASS 二代状态重置经 store 写入口落盘（带 schemaVersion）');
  // 设置每个聊天的模式时，不合法的一定要被拒绝
  const convFile = path.join(h.temp, 'state', 'conversations.json');
  // 设置某个聊天使用的模式
  const setConv = (body) => call('POST', '/api/conversations/set', { body });
  const ok1 = await setConv({ key: 'group:0456', mode: 'chat' });
  assert.equal(ok1.status, 200, JSON.stringify(ok1.json));
  assert.equal(ok1.json.conversations['group:456'].updatedBy, 'console', 'key 归一；操作者记为 console');
  for (const bad of [{ key: 'group:456', mode: 'closed-agent' }, { key: 'private:999', mode: 'closed-agent' },
    { key: 'group:456', mode: 'reserved2', preset: 'standard' }, { key: 'group:456', mode: 'nope' }, { key: 'x', mode: 'chat' }]) {
    assert.equal((await setConv(bad)).status, 400, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal((await setConv({ key: `private:${h.cfg.ownerQQ}`, mode: 'closed-agent' })).status, 200, 'owner 私聊可以指定 closed-agent');
  const onDisk = JSON.parse(fs.readFileSync(convFile, 'utf8'));
  assert.ok(Number.isInteger(onDisk.schemaVersion));
  assert.deepEqual(Object.keys(onDisk.conversations).sort(), ['group:456', `private:${h.cfg.ownerQQ}`]);
  const del = await call('POST', '/api/conversations/delete', { body: { key: 'group:456' } });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.deepEqual(Object.keys((await call('GET', '/api/conversations')).json.conversations), [`private:${h.cfg.ownerQQ}`]);
  assert.equal(h.getMode(), 'chat', '覆盖表只记录，不改全局模式');
  assert.equal(h.modeAllowed('group:456', 'group', 456, h.cfg, 'closed-agent'), false, '覆盖表不参与运行期模式判定');
  assert.match(fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8'), /会话策略 conversation-set group:456（console）/);
  console.log('PASS 会话策略覆盖表：路由器校验、落盘带 schemaVersion、审计进活动日志、不影响运行期判定');
  const rotated = 'rotated-console-token-123456';
  const rot = await call('POST', '/api/console/token', { body: { token: rotated } });
  assert.equal(rot.status, 200, JSON.stringify(rot.json));
  assert.equal((await call('GET', '/api/sessions')).status, 401, '旧令牌在轮换后必须失效');
  assert.equal((await call('GET', '/api/sessions', { token: rotated })).status, 200, '新令牌立即生效');
  console.log('PASS 访问器写路径：模式切换写到桥接；令牌轮换立即生效');
} catch (error) {
  failures += 1;
  console.error('FAIL', error?.stack ?? error);
} finally {
  await new Promise((r) => server.close(r));
  await h.close();
}
console.log(failures ? `\n${failures} 项失败` : `\nALL PASS（${routes.length} 条路由声明）`);
process.exit(failures ? 1 : 0);
