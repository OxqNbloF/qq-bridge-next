import { getModeAdapter } from '../modes/registry.js';

export function createModeMemory(b) {
  function buildModeMemory(key) {
    const adapter = getModeAdapter(b.modeForKey(key));
    if (!adapter) return '';
    return b.memoryAPI.buildContext(key, adapter.memoryPolicy);
  }
  return { buildModeMemory };
}
