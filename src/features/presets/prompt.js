// 仿真预设提示词的定位、读取、安装同步、备份与状态
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPresetPrefix } from '../../preset-prompt.js';
import { resolveInstalledPreset, synchronizePreset } from '../../preset-sync.js';
import { atomicWriteText } from '../../store/fs-atomic.js';

// 创建预设提示词管理模块
export function createPresetPrompts(b) {
  // 仿真层（预设内置的行为协议）与人格层（roles/*.md）分开；改仿真需重启 DSH
  const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
  const PRESET_BACKUP_DIR = path.join(b.STATE_DIR, 'preset-backups');
  const PRESET_BACKUP_KEEP = 10;

  /** 只接受两个预置名（缺省二代）；必须在拼路径前校验，防路径穿越 */
  function knownPresetName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) return PRESET_NAMES.v2;
    return Object.values(PRESET_NAMES).includes(name) ? name : null;
  }

  // 仓库内预设源文件路径
  function presetSourceYaml(name) {
    return path.join(b.ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
  }

  // DSH 主目录
  function dshHomeDir() {
    return b.process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  }

  // 已安装预设的 yml 路径
  function installedPresetYaml(name) {
    return resolveInstalledPreset(name, {home: dshHomeDir(), knownPresetName});
  }

  // 把源预设同步到安装位置
  function syncInstalledPreset(name, target = installedPresetYaml(name)) {
    return synchronizePreset(name, target, {knownPresetName, sourceFor: presetSourceYaml, renderPatch: b.renderPatch, writeText: atomicWriteText});
  }

  // 读预设源文件和 persona.prefix；未知预设名不得静默回退

  function readPresetPromptText(name) {
    const file = presetSourceYaml(name);
    if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(b.ROOT, file)}`);
    const text = fs.readFileSync(file, 'utf8');
    const prefix = extractPresetPrefix(text);
    if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
    return { text, prefix };
  }

  // 备份名带预设名前缀，免得还原时列出另一个预设的备份
  function presetBackupPrefix(name) {
    return `${name}.${path.basename(presetSourceYaml(name))}`;
  }

  // 备份预设源文件，只保留最近若干份
  function backupPresetFile(name) {
    const file = presetSourceYaml(name);
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
    fs.copyFileSync(file, dest);
    const prefix = presetBackupPrefix(name) + '.';
    const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
      try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
    }
    return dest;
  }

  // 列出某预设的备份，新的在前
  function listPresetBackups(name) {
    try {
      const prefix = presetBackupPrefix(name) + '.';
      return fs.readdirSync(PRESET_BACKUP_DIR)
        .filter((f) => f.startsWith(prefix))
        .sort().reverse()
        .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
    } catch {
      return [];
    }
  }

  // 返回预设状态给控制台
  function presetStatus(name) {
    // 不回传 DSH_HOME 和安装副本的绝对路径
    return {
      preset: name,
      label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
      sourceFile: path.relative(b.ROOT, presetSourceYaml(name)),
      installed: fs.existsSync(installedPresetYaml(name)),
      requiresRestart: true,
    };
  }

  return { knownPresetName, presetSourceYaml, dshHomeDir, installedPresetYaml, syncInstalledPreset, readPresetPromptText, presetBackupPrefix, backupPresetFile, listPresetBackups, presetStatus, PRESET_BACKUP_DIR, PRESET_NAMES };
}
