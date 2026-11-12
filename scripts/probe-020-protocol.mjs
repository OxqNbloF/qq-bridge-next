// 连真的 DSH 把用到的接口都摸一遍，只看不改
//
// 目的：把桥接要用到的每个接口在真 DSH 上过一遍
// 打印原始数据的结构和类型，方便核对
// 不连 SnowLuma，也不改用户数据，探测用的东西跑完就删
//
// 重点看这几件事：
// 1. session/control 开头那一帧长什么样
// 2. session/projections 能不能用，返回什么
// 3. session/follow 的当时状态帧有哪些键
// 4. $events 的 ready 和 waterfall 帧长什么样
// 5. session/updateQueue 和 session/cancel 的参数和回执
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const cookie = discoverDshSessionCookie(BASE);
if (!cookie) { console.error('❌ 无法铸造会话 Cookie（读不到 browser-session 密钥）'); process.exit(2); }

// 调用一个 DSH 接口，返回结果
async function rpc(endpoint, args) {
  const r = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p' + randomUUID().slice(0, 8), method: endpoint, payload: { args } })
  });
  const j = await r.json();
  return j.result;
}
// 判断调用是否成功
const ok = (v) => v?.ok === true;

// 只说结构不说内容：只列键名和值类型
function shape(value, depth = 0) {
  const pad = '  '.repeat(depth);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(0)';
    return `array(${value.length}) of {\n${value.slice(0, 2).map((v) => pad + '  ' + shape(v, depth + 1)).join(',\n')}\n${pad}}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return 'object{}';
    return `{\n${keys.slice(0, 25).map((k) => `${pad}  ${k}: ${shape(value[k], depth + 1)}`).join('\n')}\n${pad}}`;
  }
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number') return `number`;
  return typeof value;
}

const url = new URL('/api/remote.mux', BASE);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

const streamIds = { control: randomUUID(), follow: randomUUID(), events: randomUUID() };
const controlBaselines = [];
const controlProjections = [];
const followFrames = [];
const eventFrames = [];

const socket = new WebSocket(url, { headers: { cookie } });
let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });

const finish = setTimeout(() => { try { socket.close(); } catch {} }, 25_000);

socket.addEventListener('open', () => {
  // ① 整个控制流（桥接用它读待处理队列）
  socket.send(JSON.stringify({ type: 'open', streamId: streamIds.control, endpoint: 'session/control', payload: { args: {} } }));
  // ④ 远端事件流（提问和审批）
  socket.send(JSON.stringify({ type: 'open', streamId: streamIds.events, endpoint: '$events', payload: { args: {} } }));
  resolveReady();
});

socket.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.streamId === streamIds.control && m.type === 'item') {
    const v = m.value;
    if (v?.type === 'baseline') controlBaselines.push(v);
    else controlProjections.push(v);
  } else if (m.streamId === streamIds.follow && m.type === 'item') {
    followFrames.push(m.value);
  } else if (m.streamId === streamIds.events && m.type === 'item') {
    eventFrames.push(m.value);
  }
});
socket.addEventListener('error', (e) => console.error('socket error', e?.message ?? e));

await ready;
await new Promise((r) => setTimeout(r, 800));

console.log('=== ① session/control 开场 baseline ===');
console.log(`帧数: ${controlBaselines.length}`);
if (controlBaselines[0]) console.log(shape(controlBaselines[0]));
else console.log('（未收到 baseline）');

// 建一个临时工作区和会话，问一句，看控制流推来的帧
// 工作区放在系统临时文件夹，仓库 state/ 权限被收紧过
const probeDir = path.join(os.tmpdir(), 'qq-bridge-probe-020');
fs.rmSync(probeDir, { recursive: true, force: true });
fs.mkdirSync(probeDir, { recursive: true });
const ws = await rpc('workspace/create', { request: { title: '__probe-020__', path: probeDir } });
const wsId = ws?.value?.workspace?.workspaceId ?? ws?.value?.workspaceId;
console.log(`\n[setup] workspace=${wsId ?? '(失败)'}`);

let sessionId = null;
if (wsId) {
  const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: 'qq-chat-v2' } });
  if (!ok(sc)) console.log(`[setup] session/create 失败: ${sc?.error?.code}: ${sc?.error?.message}`);
  else {
    sessionId = sc.value.sessionId;
    console.log(`[setup] session=${sessionId} preset=${sc.value.agentPreset}`);

        // ③ 关注这个会话，记下它当时的状态数据
    socket.send(JSON.stringify({
      type: 'open', streamId: streamIds.follow, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, activate: true, maxMessages: 5 } } }
    }));

    // ② 不在会话里读取汇总视图
    const proj = await rpc('session/projections', { request: { sessionId } });
    console.log('\n=== ② session/projections ===');
    console.log(ok(proj) ? shape(proj.value) : `❌ ${proj?.error?.code}: ${proj?.error?.message}`);

    // 问一句让 inbox 里出现待处理项，控制流应该推帧
    const pm = await rpc('session/prompt', {
      request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '只回复：ok' }] }
    });
    console.log('\n[prompt]', ok(pm) ? 'accepted' : `❌ ${pm?.error?.code}: ${pm?.error?.message}`);
    await new Promise((r) => setTimeout(r, 2500));

    console.log('\n=== ③ session/follow 帧 ===');
    for (const f of followFrames.slice(0, 2)) {
      console.log(`  type=${f?.type}`);
      if (f?.type === 'snapshot') {
        console.log(`    header keys: ${Object.keys(f.header ?? {}).join(',')}`);
        console.log(`    cursor=${f.cursor} records=${f.records?.length} hasMore=${f.hasMore}`);
        console.log(`    projections: ${shape(f.projections)}`);
      }
    }
    if (!followFrames.length) console.log('  （未收到帧）');

    // ⑤ 取消的回执
    const cx = await rpc('session/cancel', { request: { sessionId } });
    console.log('\n=== ⑤ session/cancel ===');
    console.log(ok(cx) ? JSON.stringify(cx.value) : `❌ ${cx?.error?.code}: ${cx?.error?.message}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

console.log('\n=== ④ $events 帧 ===');
console.log(`帧数: ${eventFrames.length}`);
for (const f of eventFrames.slice(0, 3)) console.log('  ' + shape(f));

console.log('\n=== control 投影帧（prompt/cancel 触发的增量） ===');
console.log(`帧数: ${controlProjections.length}`);
for (const f of controlProjections.slice(0, 4)) {
  console.log(`  type=${f?.type} sessionId=${String(f?.sessionId).slice(0, 20)} key=${f?.key} seq=${f?.seq}`);
  if (f?.key === 'inbox') console.log('    inbox value: ' + shape(f.value));
  if (f?.value && typeof f.value === 'object' && f.key === undefined) console.log('    ' + shape(f));
}

// 收尾清理
clearTimeout(finish);
try { socket.close(); } catch {}
if (sessionId) {
  await rpc('session/cancel', { request: { sessionId } });
  await rpc('workspace/archiveSession', { request: { sessionId } });
  console.log('\n[cleanup] session archived');
}
if (wsId) {
  const del = await rpc('workspace/delete', { request: { workspaceId: wsId } });
  console.log(`[cleanup] workspace delete: ${ok(del) ? 'ok' : del?.error?.code}`);
}
try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
process.exit(0);
