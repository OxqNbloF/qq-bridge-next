// 检查桥接能不能看出 SnowLuma 上游还活着
// 这里盯住几处容易悄悄坏掉的地方
// 也顺带看 SDK 的补丁还需不需要
import assert from 'node:assert/strict';
import { readBridgeSource } from './bridge-source.mjs';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 上游健康代码和 /api/status 路由都搬出了 bridge.js
// 所以把 bridge.js 和搬出的模块拼起来读
const bridge = readBridgeSource();
const consoleHtml = fs.readFileSync(path.join(ROOT, 'src', 'features', 'console', 'web', 'console.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

// 只要可执行代码：注释里也会提到这些名字
const codeOf = (src) => src
  // 顺序要紧：先剥行注释，再剥块注释
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const bridgeCode = codeOf(bridge);

test('SnowLuma 客户端库不低于 bot_status 出现的版本（1.14.17）', () => {
  // 低于这个版本收不到账号上下线事件
  // 只比前三位版本号，够用，不用引版本库
  const num = (v) => {
    const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : null;
  };
  const min = num('1.14.17');
  for (const name of ['@snowluma/sdk', '@snowluma/mcp']) {
    const declared = num(pkg.dependencies?.[name]);
    assert.ok(declared !== null, `${name} 必须在 dependencies 里声明`);
    assert.ok(
      declared >= min,
      `${name} 声明为 ${pkg.dependencies[name]}，低于 1.14.17 —— 那样订阅不到 bot_status（账号上下线事件），`
      + '上游健康会少一个信号。',
    );
  }
});

test('客户端库确实可被纯 Node ESM 解析（postinstall 补丁的成果）', async () => {
  // 上游打包有 bug，靠补丁才能被 Node 直接加载
  // 所以「能 import」本身就证明补丁生效了
  const sdk = await import('@snowluma/sdk');
  assert.equal(typeof sdk.SnowLumaWebSocketClient, 'function', 'SnowLumaWebSocketClient 应可导入');
  assert.match(String(pkg.scripts?.postinstall ?? ''), /patch-snowluma-sdk/, 'postinstall 必须仍挂补丁脚本');

  // 顺带看看还有没有没补上的相对导入
  // 这里只提示不断言：补过之后自然查不到
  const dist = path.join(ROOT, 'node_modules', '@snowluma', 'sdk', 'dist');
  let unresolved = 0;
  // 递归扫一遍 dist 目录里的文件
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        const spec = m[1];
        if (spec.endsWith('.js') || spec.endsWith('.json')) continue;
        const t = path.resolve(path.dirname(full), spec);
        if (fs.existsSync(t + '.js') || fs.existsSync(t + '.json')) unresolved += 1;
      }
    }
  };
  if (fs.existsSync(dist)) {
    walk(dist);
    console.log(unresolved === 0
      ? '  ℹ️  dist 中没有未修的相对导入（补丁已生效，或上游已修好 —— 两种情况都不需要动作）'
      : `  ⚠️  dist 中仍有 ${unresolved} 处未修的相对导入：postinstall 可能没跑到，请重跑 npm install`);
    assert.equal(unresolved, 0, 'dist 里不应残留未修的相对导入（否则 postinstall 没生效）');
  } else {
    console.log('  ⏭  跳过 dist 扫描：@snowluma/sdk 未安装');
  }
});

test('桥接订阅了「上游还活着」的证据（onEvent）', () => {
  assert.match(bridgeCode, /bot\.onEvent\(/, '必须用 onEvent 旁路统计上游事件包（静默检测的依据）');
  assert.match(bridgeCode, /noteUpstreamPacket\(/, 'onEvent 回调必须记账到 noteUpstreamPacket');
});

test('桥接订阅了 bot_status（账号上下线），且对老运行时优雅降级', () => {
  assert.match(bridgeCode, /bot\.onBotStatus\(/, '必须订阅 bot_status');
  // 老版本不发这个事件，订阅失败只提示不致命
  assert.match(bridgeCode, /bot_status 订阅不可用/, '订阅失败必须明确提示（老运行时应优雅降级）');
});

test('good 取自心跳 status.good / get_status —— 绝不能取自 get_login_info', () => {
  // 这是本文件最重要的理由：取错字段不会报错
  // get_login_info 只给账号和昵称，没有 good
  // get_status 和 30 秒心跳才有 online/good
  // SDK 不检查返回内容，所以取错字段永远不报错
  // 只会让 good 一直是空，信号永远不触发
  assert.match(bridgeCode, /\/get_status/, '必须轮询 get_status 拿 online/good');
  assert.match(bridgeCode, /body\.data\?\.good/, 'get_status 的 good 必须被读取');
  // 主信号：心跳里的 status.good
  assert.match(bridgeCode, /meta_event_type === 'heartbeat'/, '必须识别 meta_event/heartbeat');
  assert.match(bridgeCode, /event\.status\?\.good/, '必须从心跳载荷读 status.good（主信号）');
  assert.match(bridgeCode, /noteReceiveHealth\(/, '心跳/轮询都必须经 noteReceiveHealth 归一记录');
  // 反面：不能再从 get_login_info 拿 good
  const loginCall = bridgeCode.slice(
    Math.max(0, bridgeCode.indexOf('/get_login_info') - 400),
    bridgeCode.indexOf('/get_login_info') + 900,
  );
  assert.ok(loginCall.length > 0, '应能定位 get_login_info 调用点');
  assert.ok(
    !/good/.test(loginCall.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'get_login_info 的返回里没有 good —— 不要从它身上取（会静默失效）。'
    + '若要昵称就用它，要 online/good 就用 get_status 或心跳。',
  );
});

test('静默检测不得声称能判断 hook 死活（心跳是本地生成的）', () => {
  // 心跳是 SnowLuma 自己的定时器无条件发的
  // 所以没有事件包只能说明进程或连接卡住了
  // 不能说明它的 Hook 收不到消息
  // 写成「沉默=Hook 死了」会把人带错方向
  const silentHint = bridgeCode.slice(
    bridgeCode.indexOf('else if (silent)'),
    bridgeCode.indexOf('else if (silent)') + 420,
  );
  assert.ok(silentHint.length > 0, '应能定位静默分支的提示文案');
  assert.ok(
    !/\[Hook\]/.test(silentHint),
    '静默分支不得把结论指向 [Hook]（心跳会一直来，沉默说明的是进程/WS 层面）',
  );
  assert.match(silentHint, /心跳/, '静默分支应点明"连心跳都没有"，把结论落在进程/WS 上');
});

test('/api/status 暴露 snowluma 健康快照，且只给操作者', () => {
  assert.match(bridgeCode, /snowluma: snowlumaHealthSnapshot\(\)/, '/api/status 必须带 snowluma 字段');
  // 智能体视图（带令牌那支）不能带这个字段
  const agentBranch = bridgeCode.slice(
    bridgeCode.indexOf("req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined"),
    bridgeCode.indexOf('snowluma: snowlumaHealthSnapshot()'),
  );
  assert.ok(agentBranch.length > 0, '应能定位智能体分支与操作者分支');
  assert.ok(
    !/snowluma\s*:/.test(agentBranch),
    '受限的智能体视图不得带 snowluma 诊断字段（那是管理侧观测）',
  );
});

test('控制台有对应的告警条与卡片', () => {
  assert.match(consoleHtml, /id="snowlumaWarn"/, '控制台应有 SnowLuma 告警条');
  assert.match(consoleHtml, /renderSnowlumaHealth\(/, '告警条必须被接线到 /api/status 的渲染路径');
  assert.match(consoleHtml, /\[Hook\]/, '告警文案必须把排查方向指向 SnowLuma 的 [Hook] 日志');
});

test('端点自愈可关，且默认保持「跟随」（向后兼容）', () => {
  assert.match(
    bridgeCode,
    /cfg\.snowluma\?\.followDiscoveredEndpoint !== false/,
    '必须支持 snowluma.followDiscoveredEndpoint 关闭端点跟随',
  );
  assert.equal(
    example.snowluma?.followDiscoveredEndpoint, true,
    '示例配置里默认值必须是 true —— 关闭会改变既有自愈行为，不能悄悄改默认',
  );
  // 关掉跟随时不能把发现的地址写回配置文件
  assert.match(
    bridgeCode,
    /\.\.\.\(followEndpoint \? \{ wsUrl, httpUrl: r\.baseUrl \} : \{\}\)/,
    '关闭跟随时不得把 wsUrl 写回 config.json（否则"我设了别处"会被持久化抹掉）',
  );
  assert.equal(typeof example.snowluma?.silenceWarnMs, 'number', '示例配置应记录静默告警阈值');
});
