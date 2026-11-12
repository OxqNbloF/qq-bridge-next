import fs from 'node:fs';
import path from 'node:path';

// 定位已安装的 preset 目录（setup-dsh 链接到 DSH_HOME/plugins）
export function resolveInstalledPreset(name, {home, knownPresetName}) {
  if (!knownPresetName(name)) throw new Error('Unknown preset');
  const bundle = path.join(home, 'plugins', 'qq-agent-presets', 'presets', name + '.patch.yml');
  if (fs.existsSync(bundle)) return bundle;
  return path.join(home, '.agent-presets', name, 'agent.cordis.yml');
}

// 把 preset 同步到目标；bundle 是渲染出的补丁，不能直接拷 yml
export function synchronizePreset(name, target, {knownPresetName, sourceFor, renderPatch, writeText}) {
  if (!knownPresetName(name)) throw new Error('Unknown preset');
  if (!fs.existsSync(target)) return {synced: false, changed: false};
  const content = target.endsWith('.patch.yml') ? renderPatch(name) : fs.readFileSync(sourceFor(name), 'utf8');
  const changed = fs.readFileSync(target, 'utf8') !== content;
  if (changed) writeText(target, content);
  return {synced: true, changed};
}
