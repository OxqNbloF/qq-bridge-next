// 找「发语音」工具在哪个文件夹，没有时统一说「跳过」
// 它在仓库上一级，别人的电脑上可能根本没这个工具
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本仓库所在的文件夹
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 发语音工具所在的文件夹，可用环境变量指定
export function voiceToolDir() {
  const override = process.env.QQ_BRIDGE_VOICE_TOOL_DIR;
  if (override) return path.resolve(override);
  return path.resolve(REPO_ROOT, '..', 'voice-tool');
}

// 这个文件夹在不在、像不像那个工具
export function hasVoiceTool() {
  const dir = voiceToolDir();
  return fs.existsSync(path.join(dir, 'voice-cli.mjs'))
    || fs.existsSync(path.join(dir, 'voice-gui.mjs'));
}

// 拼出工具文件夹里某个文件的路径
export function voiceToolPath(...segments) {
  return path.join(voiceToolDir(), ...segments);
}

// 说一声这次跳过了（不是通过），方便提前返回
export function skipVoiceTool(what) {
  console.log(`  ⏭  跳过：${what}`);
  console.log(`     原因：独立发语音工具不在本仓库里（它是仓库上一级的 ../voice-tool/），当前解析到 ${voiceToolDir()}`);
  console.log('     想跑这些断言：把仓库与 voice-tool/ 放在同一级目录下，或设 QQ_BRIDGE_VOICE_TOOL_DIR=<voice-tool 目录>。');
  console.log('     注意：这是**跳过，不是通过** —— 这台机器上没有覆盖到这部分。');
  return false;
}
