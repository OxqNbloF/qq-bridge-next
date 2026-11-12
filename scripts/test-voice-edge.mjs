// 检查语音系统同时来多个请求、乱输入、重名时会不会崩
// 需要图形界面服务开着；默认跳过，免得要外部程序
//
// 用法：
// 1. 先另开窗口跑 voice-gui.mjs --port 3215
// 2. 再设 QQ_BRIDGE_TEST_LIVE=1 跑这个测试
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
// 检查一项，通过就打勾，失败就记一笔
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 离线部分：只测纯函数
console.log('## 纯函数边界');
{
  const core = await import(new URL('../src/voice-core.js', import.meta.url).href);

  ok(core.listAudioFiles(path.join(ROOT, 'no-such-dir-xyz')).length === 0, '目录不存在 → 返回空数组（不抛）');
  ok(core.describeAudio(null) === '未知音频', 'describeAudio(null) 不炸');
  ok(core.describeAudio({}) === '未知音频', 'describeAudio({}) 不炸');
  ok(core.formatDuration(0) === '0秒' && core.formatDuration(-5) === '0秒', '负时长被夹到 0');
  ok(core.formatBytes(0) === '0 B', 'formatBytes(0)');
  ok(core.parseTargetKey('group:0') === null, 'group:0 视为非法（QQ 号必须为正）');
  ok(core.parseTargetKey('GROUP:1') === null, '大写 GROUP 不识别（大小写敏感，避免歧义）');
  ok(core.sanitizeUploadName('') === 'audio.mp3', '空文件名 → audio.mp3');
  ok(core.sanitizeUploadName('a'.repeat(300)).length <= 120, '超长文件名被截断到 ≤120');
  ok(core.sanitizeUploadName('a'.repeat(300)).endsWith('.mp3'), '截断后仍带扩展名');

  // 同名文件编号一直加，不能卡死
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'voice-uniq-'));
  fs.writeFileSync(path.join(tmp, 'x.mp3'), '1');
  ok(core.uniqueLibraryPath(tmp, 'x.mp3').endsWith('x-2.mp3'), '同名 → x-2.mp3');
  for (let i = 2; i <= 4; i++) fs.writeFileSync(path.join(tmp, `x-${i}.mp3`), '1');
  ok(core.uniqueLibraryPath(tmp, 'x.mp3').endsWith('x-5.mp3'), '连续同名 → x-5.mp3');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 在线部分：同时请求和异常输入
if (process.env.QQ_BRIDGE_TEST_LIVE !== '1') {
  console.log('\n## 并发/端点（跳过：设 QQ_BRIDGE_TEST_LIVE=1 且 GUI 已启动）');
} else {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = Number(portArg ? portArg.split('=')[1] : (process.env.VOICE_GUI_PORT || 3215));
  const base = `http://127.0.0.1:${port}`;
  // 图形界面在 voice-tool/ 里，令牌文件也在那儿，旧位置也找一下
  const tokenFiles = [
    path.resolve(ROOT, '..', 'voice-tool', 'state', 'voice-gui-url.txt'),
    path.join(ROOT, 'state', 'voice-gui-url.txt')
  ];
  let token = '';
  try {
    for (const f of tokenFiles) {
      const m = (fs.readFileSync(f, 'utf8').match(/[?&]t=([\w-]+)/) || [])[1];
      if (m) { token = m; break; }
    }
  } catch {}
  if (!token) {
    ok(false, `无法从 voice-tool/state/voice-gui-url.txt 取到令牌（GUI 是否在 ${port} 上运行？）`);
  } else {
    const headers = { 'x-voice-token': token, 'content-type': 'application/json' };
    const boot = await fetch(`${base}/api/bootstrap`, { headers }).then((r) => r.json());
    const voice = boot.library?.items?.find((v) => v.ok !== false);
    const group = boot.targets?.groups?.[0];

    console.log('\n## 并发 dry-run（10 个同时打）');
    {
      const t0 = Date.now();
      const results = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/send`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: voice.name, target: group.key, dryRun: true })
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }))));
      const good = results.filter((r) => r.ok === true && r.dryRun === true).length;
      ok(good === 10, '10 个并发请求全部成功', `${good}/10，耗时 ${Date.now() - t0}ms`);
      ok(new Set(results.map((r) => r.detail)).size === 1, '并发结果一致（无串台）');
    }

    console.log('\n## 异常输入');
    const cases = [
      ['空 body', {}, 400],
      ['未知语音', { name: '不存在.mp3', target: group.key, dryRun: true }, 404],
      ['非法目标', { name: voice.name, target: 'group:abc', dryRun: true }, 400],
      ['缺目标', { name: voice.name, dryRun: true }, 400],
      ['穿越路径', { name: '../../../config.json', target: group.key, dryRun: true }, 400],
      ['None 目标类型', { name: voice.name, target: 'channel:1', dryRun: true }, 400],
    ];
    for (const [label, body, expect] of cases) {
      const res = await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      ok(res.status === expect || json.ok === false, `${label} 被拒`, `HTTP ${res.status}${json.error ? ' — ' + json.error : ''}`);
    }

    console.log('\n## 上传边界');
    {
      const r1 = await fetch(`${base}/api/upload?name=${encodeURIComponent('测试 空格+特殊#字符.mp3')}`, {
        method: 'POST', headers: { 'x-voice-token': token, 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(600, 9)
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
      ok(r1.ok === true, '特殊字符文件名可上传', r1.saved ?? r1.error ?? '');
      if (r1.ok) {
        const readBack = await fetch(`${base}/api/audio?t=${encodeURIComponent(token)}&name=${encodeURIComponent(r1.saved)}`);
        ok(readBack.status === 200, '上传后可按名字取回（特殊字符不破）', `HTTP ${readBack.status}`);
        await fetch(`${base}/api/delete`, { method: 'POST', headers, body: JSON.stringify({ name: r1.saved }) }).catch(() => {});
        // 删除默认关闭，测试自己产生的文件自己清
        try { fs.unlinkSync(path.join(boot.library.dir, r1.saved)); } catch {}
      }
      const empty = await fetch(`${base}/api/upload?name=empty.mp3`, {
        method: 'POST', headers: { 'x-voice-token': token, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(0)
      });
      ok(empty.status === 400, '空文件被拒', `HTTP ${empty.status}`);
      const tooBig = await fetch(`${base}/api/upload?name=big.mp3`, {
        method: 'POST', headers: { 'x-voice-token': token, 'content-type': 'application/octet-stream' },
        body: Buffer.alloc((boot.library?.limits?.maxBytes || 20 * 1024 * 1024) + 1024, 1)
      }).then((r) => r.status).catch(() => 0);
      ok(tooBig === 413 || tooBig === 400, '超过体积上限被拒', `HTTP ${tooBig}`);
    }

    console.log('\n## 未知接口与越权');
    {
      const notFound = await fetch(`${base}/api/nope`, { headers }).then((r) => r.status);
      ok(notFound === 404, '未知接口 404', `HTTP ${notFound}`);
      const noToken = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
      ok(noToken === 401, '无令牌 401', `HTTP ${noToken}`);
      const badToken = await fetch(`${base}/api/library`, { headers: { 'x-voice-token': 'x'.repeat(token.length) } }).then((r) => r.status);
      ok(badToken === 401, '错误令牌 401（长度相同也不放行）', `HTTP ${badToken}`);
    }
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
