import { normalizeModeInput } from '../policy/mode.js';
import { canonicalV2Key } from '../policy/access.js';

// closed-agent 的全工具权限只属于 owner 私聊，任何来源都不能放宽。
export function resolveMode(key, { globalMode, defaults = {}, overrides = {}, ownerQQ, enabled = {} }) {
  const canonical = canonicalV2Key(key);
  if (!canonical) return { mode: null, source: 'invalid' };
  const explicit = overrides[canonical];
  const candidate = normalizeModeInput(explicit?.mode ?? defaults[key.split(':')[0]] ?? globalMode);
  const source = explicit?.mode != null ? 'conversation' : defaults[key.split(':')[0]] != null ? 'type' : 'global';
  const mode = enabled[candidate] === true ? candidate : normalizeModeInput(globalMode);
  const effectiveSource = enabled[candidate] === true ? source : 'global';
  if (mode === 'closed-agent' && (key !== `private:${ownerQQ}` || !/^[1-9]\d*$/.test(String(ownerQQ ?? '')))) return { mode: null, source: effectiveSource };
  // 类型默认永不获得全工具权限；保留旧全局 closed-agent 配置兼容。
  if (mode === 'closed-agent' && effectiveSource === 'type') return { mode: null, source: effectiveSource };
  return { mode, source: effectiveSource };
}
