// 检查能不能自动找到 SnowLuma 的账号和令牌
//
// 令牌按 QQ 账号分文件存，换账号后写死的令牌就失效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverSnowLumaConnection, persistToken, readOneBotHttpTokens, readOneBotTokens, snowLumaHomeCandidates
} from '../src/snowluma-conn.js';
// 发语音工具在仓库上一级；先看它在不在，不在就跳过
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
// 记一次检查结果：通过打勾，失败打叉
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
// 工具不在本仓库时返回 null，后面的检查还能照跑
// 读工具目录里的一个文件，没有就返回 null
const readTool = (rel) => (hasVoiceTool() ? fs.readFileSync(voiceToolPath(rel), 'utf8') : null);

console.log('## home 目录推断');
{
  const homes = snowLumaHomeCandidates({ cfg: { snowluma: { homeDir: 'X:/sl', launcherPath: 'X:/sl2/launcher.bat' } } });
  ok(homes.includes('X:/sl'), '优先用 homeDir');
  ok(homes.some((h) => h.replace(/\\/g, '/') === 'X:/sl2'), '其次用 launcherPath 所在目录');
  ok(snowLumaHomeCandidates({ cfg: {} }).length >= 0, '无配置时返回空或环境变量值（不抛错）');
}

console.log('## per-account token 解析（用临时目录造多账号场景）');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  // 造一个某个 QQ 号的 OneBot 配置文件
  const write = (uin, httpToken, port = 3000, wsToken = 'ws-' + uin) => fs.writeFileSync(
    path.join(home, 'config', `onebot_${uin}.json`),
    JSON.stringify({ networks: { httpServers: [{ name: 'http-default', accessToken: httpToken, host: '127.0.0.1', port }], wsServers: [{ accessToken: wsToken, port: 3001 }] } }),
    'utf8'
  );
  write('111', 'token-aaa');
  write('222', 'token-bbb');
  fs.writeFileSync(path.join(home, 'config', 'onebot_broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'runtime.json'), '{}', 'utf8');

  const toks = readOneBotTokens(home);
  ok(toks.length === 2, '只解析出 onebot_<数字>.json', `得到 ${toks.length} 个`);
  ok(toks[0].uin === '111' && toks[1].uin === '222', '按 uin 稳定排序');
  ok(toks.every((t) => t.http?.token?.startsWith('token-')), 'HTTP token 取自 httpServers');
  ok(toks.every((t) => t.ws?.token?.startsWith('ws-')), 'WS token 取自 wsServers（与 HTTP 不同！）');
  ok(toks.every((t) => t.http.token !== t.ws.token), '两个 token 确实不同（不能混用的证据）');
  ok(toks.every((t) => t.http.port === 3000 && t.ws.port === 3001), '端口分别是 3000 / 3001');

  const flat = readOneBotHttpTokens(home);
  ok(flat.length === 2 && flat[0].token === 'token-aaa', 'readOneBotHttpTokens 兼容扁平形态');

  console.log('## 自动发现：按"谁能用"选择，而不是猜');
  // 用一个假 fetch 模拟：只有 token-bbb 是有效的
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (tk === 'token-bbb') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 222, nickname: '第二账号' } }) };
    }
    return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
  };
  try {
    const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 500 });
    ok(r.ok === true, '发现成功');
    ok(r.token === 'token-bbb', '选中了有效的那个 token', r.token);
    ok(r.self?.user_id === 222, '回报当前账号', String(r.self?.user_id));
    ok(r.source === 'onebot_222.json', '标明 token 来源', r.source);
    ok(r.tried.length === 2, '记录了尝试过的候选', `${r.tried.length} 个`);

    // 全部无效时要给出能照着修的错误提示
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) });
    const bad = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 300 });
    ok(bad.ok === false, '全部失效时失败');
    ok(/401|token/.test(bad.error), '错误信息指出 token 问题', bad.error.slice(0, 40));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## token 写回 config.json');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'old-token' }, allow: { groups: [1] } }, null, 2), 'utf8');
  const r1 = persistToken(cfgPath, 'new-token');
  ok(r1.updated === true && r1.from === 'old-token', '换 token 时写入');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(after.snowluma.accessToken === 'new-token', 'config.json 已更新');
  ok(after.allow.groups[0] === 1, '其它配置字段未被破坏');
  const r2 = persistToken(cfgPath, 'new-token');
  ok(r2.updated === false, 'token 未变时不重复写（幂等）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 独立工具确实用它（源码级）');
{
  // 工具入口在仓库上一级，共享内核还是本仓库的
  for (const rel of ['voice-cli.mjs', 'voice-gui.mjs']) {
    const src = readTool(rel);
    if (src === null) { skipVoiceTool(`${rel} 是否引入自发现模块（snowluma-conn.js / discoverSnowLumaConnection）`); continue; }
    ok(/snowluma-conn\.js/.test(src), `${rel} 引入自发现模块`);
    ok(/discoverSnowLumaConnection/.test(src), `${rel} 调用自动发现`);
  }
  // 下面几条查的是本仓库的桥接代码，跟工具无关
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  ok(/healTokenIfStale/.test(bridge), 'bridge 有 token 自愈');
  ok(/persistToken/.test(bridge), 'bridge 会把有效 token 写回 config.json');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
