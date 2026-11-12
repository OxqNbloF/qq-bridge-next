// 端到端验证：挂上 preset 真跑一轮，看能用哪些工具
// 应该能调 MCP 工具，本地危险工具不该在清单里
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

// 登录和连接统一交给 probe-auth.mjs，旧的抓令牌办法已作废
const cookie = probeCookie();
const rpc = probeRpc(cookie);

const PRESET = process.argv[2] || 'qq-chat';
// 探测用的文件夹建在系统临时目录里，仓库里写不进去
const dir = probeWorkspaceDir('tools');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const model = await rpc('session/selectModel', { request: { sessionId: 'x', provider: 'x', model: 'x' } }); // 只看接口形状，结果不用管

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

// 把会话的模型切到桥接用的那一个
const sm = await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('selectModel ->', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.code}: ${sm.error.message}`);

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 120_000);
  // 结束等待：停掉计时器并说明原因
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, activate: true } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: {
          sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: '请调用 mcp__snowluma-host__snowluma_status 工具一次，然后只回复：完成' }]
        }
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 120));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName, args: e.data?.arguments ?? e.data?.args });
    if (e.type === 'tool/result') toolResults.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.isError ?? e.data?.error !== undefined });
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 200)));
console.log('tool/call:', JSON.stringify(toolCalls));
console.log('tool/result:', JSON.stringify(toolResults));

const calledMcp = toolCalls.some((c) => String(c.name).startsWith('mcp__snowluma-host__'));
const calledLocal = toolCalls.some((c) => /^(pwsh|bash|write|edit|apply_patch|str_replace_editor|read|glob|grep)$/.test(String(c.name)));
console.log('\n判定:');
console.log(`  MCP 工具可调用          : ${calledMcp ? '✅' : '❌ 未观测到 mcp__snowluma-host__ 调用'}`);
console.log(`  未调用本地危险工具      : ${calledLocal ? '❌ 出现了本地工具调用' : '✅'}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
// 探针工作区也删掉，不然每跑一次侧栏就多一个
try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
// 临时文件夹也删掉，别留垃圾
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('[cleanup] session archived, probe workspace deleted');
process.exit(calledMcp && !calledLocal ? 0 : 1);
