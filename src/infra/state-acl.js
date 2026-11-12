// 启动时收紧 state/ 权限并回报结果

/**
 * 收紧 state/ 为 700，失败时打印手动命令
 * @returns {boolean} 是否已收紧
 */
export function hardenStateDirAcl({ dir, hardenDir, manualDirCommand, log }) {
  const result = hardenDir(dir);
  if (result.ok) return true;
  log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${String(result.detail).slice(0, 300)}`);
  log(`   本机其他用户可能读到控制台令牌与 QQ 聊天记录。请手动执行：${manualDirCommand(dir)}`);
  return false;
}
