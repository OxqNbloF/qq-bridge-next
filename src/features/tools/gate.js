// 二代工具开关的调用期判定：开关为 false 的工具调用时 403

export function createToolGate(b) {
  // 查配置判断某个二代工具是否开启
  function v2ToolEnabled(flag) {
    return b.cfg.socialV2?.tools?.[flag] !== false;
  }

  return { v2ToolEnabled };
}
