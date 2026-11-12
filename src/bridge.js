// 桥接启动入口：处理系统信号、出错保底，然后启动 main()
import { main, app, log, saveState, releaseLock } from './app.js';

process.on('SIGINT', () => {
  log('退出中…');
  app.flushSocialV2State?.(); /* 把还攒在手里、没存盘的消息先存下去 */
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  app.flushSocialV2State?.();
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 记完整 stack，便于区分偶发和持续故障
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/** 接住没被处理的错误：输出断开时不能让进程死掉 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { app.flushSocialV2State?.(); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => {
    // 退出前把攒着的改动都存到硬盘
  try { app.flushSocialV2State?.(); } catch {}
  releaseLock();
});

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
