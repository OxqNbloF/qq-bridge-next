// 自己测一下能不能连上 DSH：建个临时会话，发一句话，等回复
// 用法：node src/self-test.js [地址]
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 记下自测用的连接和会话，结束时好清理
let selfTestApi = null;
let selfTestSessionId = null;

/**
 * 把自测用的会话归档掉，别留在用户的 DSH 里。
 */
async function cleanupSelfTestSession() {
  if (!selfTestApi || !selfTestSessionId) return;
  const sid = selfTestSessionId;
  selfTestSessionId = null;
  try {
    await selfTestApi.workspace.archiveSession({ sessionId: sid });
    console.log('🧹 已归档自测会话:', sid);
  } catch (error) {
    console.log('⚠️ 自测会话归档失败（可在 DSH 里手动删除）:', sid, error?.message ?? error);
  }
}

// 跑一遍自测：连 DSH、发一句话、等回复
async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  const api = new NodeApiClient(baseUrl, undefined, auth);
  selfTestApi = api;
  const promptText = process.argv[3] ?? '只回复两个字：收到';

  const desc = unwrap(await api.settings.describe({}), 'settings.describe');
  console.log('✅ DSH 连接成功:', JSON.stringify(desc).slice(0, 200));

  // 测试会话放在系统临时目录，不放进仓库的 state 目录
  // 那个目录权限收得紧，自测在里面建目录会被拒绝
  const cwd = path.join(os.tmpdir(), 'qq-bridge-self-test');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  const sessionId = created.sessionId;
  selfTestSessionId = sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  // 先订好事件流，再发消息
  // 连接没打开就发，回复事件可能在建立前就丢了
  const collector = createTurnCollector();
  let resolveOpened;
  let openTimer;
  const opened = new Promise((resolve, reject) => {
    openTimer = setTimeout(() => reject(new Error('等待 WebSocket open 超时（10s）')), 10_000);
    resolveOpened = () => { clearTimeout(openTimer); resolve(); };
  });
  const stream = api.events.mux({}, undefined, () => resolveOpened());
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（60s）')), 60_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
  await opened;
  // 要告诉 DSH 关注这个会话，事件才会推过来
  stream.follow(sessionId);

  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }), 'session.prompt');
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const ended = await done;
  console.log('✅ 回合结束 reason =', ended.reason.kind);
  console.log('🤖 agent 回复:');
  console.log(ended.text || '（无文本）');
  await cleanupSelfTestSession();
  console.log('🎉 自测通过 —— DSH 侧链路可用');
  process.exit(0);
}

main().catch(async (error) => {
  console.error('❌ 自测失败:', error?.message ?? error);
  await cleanupSelfTestSession();
  process.exit(1);
});
