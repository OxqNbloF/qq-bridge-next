// 检查启动脚本和中文编码是否正常
// 1. 所有 .cmd 文件必须只有英文和符号
// 2. 换行必须是 CRLF，否则批处理会读错
// 3. 中文由 node 打印，控制台要设成 UTF-8
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 发语音工具在仓库上一级，找不到就跳过
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
// 检查一项，通过就打勾，不通过就记为失败
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 有些 .cmd 文件不在本仓库里，在仓库上一级
// 仓库里有的缺了才算失败，外面的缺了跳过
const OUTSIDE_REPO_LAUNCHERS = new Set(['发语音-图形界面.cmd', '重启DSH-加载语音工具.cmd']);
// 判断一个启动脚本在仓库里还是仓库外
const launcherKind = (f) => {
  const abs = path.resolve(f);
  const inRepo = abs === ROOT || abs.startsWith(ROOT + path.sep);
  if (inRepo) return 'repo';
  return OUTSIDE_REPO_LAUNCHERS.has(path.basename(abs)) ? 'parent' : 'tool';
};

const launchers = [
  path.join(ROOT, '..', '发语音-图形界面.cmd'),
  path.join(ROOT, '..', '重启DSH-加载语音工具.cmd'),
  voiceToolPath('发语音.cmd'),
];

console.log('## 启动器文件编码（乱码根因）');
for (const f of launchers) {
  const label = path.basename(f);
  if (!fs.existsSync(f)) {
    const kind = launcherKind(f);
    if (kind === 'parent') skipVoiceTool(`上级启动器 ${label}（和 voice-tool/ 并排，不在本仓库里）`);
    else if (kind === 'tool') skipVoiceTool(`voice-tool/${label}（独立发语音工具不在本仓库里）`);
    else ok(false, `${label} 存在`);
    continue;
  }
  const buf = fs.readFileSync(f);
  const nonAscii = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) nonAscii.push(i);
  ok(nonAscii.length === 0, `${label} 纯 ASCII`, nonAscii.length ? `${nonAscii.length} 个非 ASCII 字节（cmd 会按 GBK 解码 → 乱码）` : '');
  const text = buf.toString('latin1');
  ok(!/(?<!\r)\n/.test(text), `${label} 使用 CRLF 换行`, /(?<!\r)\n/.test(text) ? '存在裸 LF（多行 if 块可能解析失败）' : '');
  ok(!buf.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${label} 无 UTF-8 BOM`, '');
}

console.log('## Node 侧 UTF-8 输出');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-gui.mjs / voice-cli.mjs 的 chcp 65001 与中文文案断言（两个入口都在仓库上一级的 voice-tool/ 里）');
} else {
    // 中文由 node 打印，先把控制台切到 UTF-8 免得乱码
  const gui = fs.readFileSync(voiceToolPath('voice-gui.mjs'), 'utf8');
  ok(/chcp/.test(gui) && /65001/.test(gui), 'voice-gui.mjs 把控制台切到 UTF-8（chcp 65001）');
  ok(/process\.stdout\.isTTY/.test(gui), 'voice-gui.mjs 只在真控制台时切编码（不干扰管道）');
  const cli = fs.readFileSync(voiceToolPath('voice-cli.mjs'), 'utf8');
  ok(/chcp/.test(cli) && /65001/.test(cli), 'voice-cli.mjs 把控制台切到 UTF-8（chcp 65001）');
  ok(/process\.stdout\.isTTY/.test(cli), 'voice-cli.mjs 只在真控制台时切编码（不干扰管道）');
    // 中文提示语还在，没被误删
  ok(/语音发送工具/.test(gui), 'voice-gui.mjs 中文文案保留');
  ok(/语音发送工具/.test(cli), 'voice-cli.mjs 中文文案保留');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
