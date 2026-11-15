import { TOOL_ROUTES, assertToolMemberAllowed } from '../../gate/tool.js';

// 二代工具开关的调用期判定：开关为 false 的工具调用时 403

export function createToolGate(b) {
  // 查配置判断某个二代工具是否开启
  function v2ToolEnabled(flag) {
    return b.cfg.socialV2?.tools?.[flag] !== false;
  }

  function toolFlagAllowed(key, flag) {
    if (!v2ToolEnabled(flag)) return false;
    const policy = b.modeAdapterForKey(key)?.toolPolicy;
    const rules = Object.values(TOOL_ROUTES).filter(rule => rule[1] === flag);
    if (!policy || !rules.length) return false;
    // 一个 flag 可能公告多个操作（memory、sendVoice）；不能只挑宽松的 GET。
    return rules.every(rule => {
      if (!policy.groups.includes(rule[0]) || policy.deny.includes(flag)) return false;
      try { assertToolMemberAllowed(b, key, rule); return true; }
      catch { return false; }
    });
  }

  return { v2ToolEnabled, toolFlagAllowed };
}
