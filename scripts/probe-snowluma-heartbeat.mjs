// 连上 SnowLuma 的机器人网关，等它发一次心跳看看
// 心跳里带着在线和健康状态
//
// 上游是否健康，主要看心跳里的 status.good
// 这是 SnowLuma 对收消息流程的自评
// 字段名写错不会报错，只能连真的服务验证
//
// 只看不写：不发言、不建会话，打印完就退出
// 用法：node scripts/probe-snowluma-heartbeat.mjs
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const timeoutMs = (Number(process.argv[2]) || 45) * 1000;

// 用项目自带的发现逻辑拿当前可用的令牌和地址
// 不直接用配置里的值，换过账号后那个就过期了
// 正式代码也是这么找的
const disc = await discoverSnowLumaConnection({ cfg, timeoutMs: 5000 });
if (!disc.ok) {
  console.log(`❌ 无法发现可用的 SnowLuma 连接：${disc.error}`);
  process.exit(2);
}
console.log(`已发现端点 ${disc.wsUrl}（令牌${disc.wsToken || disc.token ? '已配置' : '未配置'}，来源 ${disc.source}）`);

const bot = new SnowLumaWebSocketClient({
  url: disc.wsUrl,
  accessToken: disc.wsToken || disc.token || undefined,
  reconnect: false,
});

const seen = new Map();
let done = false;
// 打印结果并断开连接，然后退出
const finish = (why) => {
  if (done) return;
  done = true;
  console.log(`\n=== 结果（${why}）===`);
  console.log('收到的事件类型：');
  for (const [k, n] of [...seen].sort()) console.log(`  ${k} x${n}`);
  try { bot.close(); } catch {}
  process.exit(0);
};

bot.onEvent((event) => {
  const post = String(event?.post_type ?? '?');
  const sub = event?.meta_event_type ? `${post}/${event.meta_event_type}` : (event?.notice_type ? `${post}/${event.notice_type}` : post);
  seen.set(sub, (seen.get(sub) ?? 0) + 1);

  if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
    console.log('✅ 收到 heartbeat —— 心跳是**本地定时器**发的，与 QQ 是否有消息无关');
    console.log('   status =', JSON.stringify(event.status));
    console.log('   interval =', event.interval);
    console.log(`   → status.good = ${JSON.stringify(event.status?.good)}` +
      (typeof event.status?.good === 'boolean'
        ? '  ✅ 字段存在（桥接的上游健康主信号可用）'
        : '  ❌ 字段缺失/非布尔 —— 桥接的 good 会一直停在 null！'));
    console.log(`   → status.online = ${JSON.stringify(event.status?.online)}`);
    finish('拿到心跳');
  }
});

bot.on('error', (e) => console.log('  ws error:', e?.message ?? e));
bot.connect().then(() => console.log(`已连接 ${cfg.snowluma.wsUrl}（只读，不发消息），等心跳…`))
  .catch((e) => { console.log('连接失败:', e?.message ?? e); finish('连接失败'); });

setTimeout(() => finish('超时'), timeoutMs);
