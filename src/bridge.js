// 桥接启动入口：处理系统信号、出错保底，然后启动 main()
import { main, app, log, saveState, releaseLock } from './app.js';

process.on('SIGINT', () => {
  log('退出中…');
  app.shutdownRequested = true; /* 在途补偿不再发起新回执，队列随状态落盘，重启后续补 */
  app.flushSocialV2State?.(); /* 把还攒在手里、没存盘的消息先存下去 */
  app.flushIdentity?.();
  try { saveState(); } catch (error) { log('退出前保存状态失败:', error?.message ?? error); }
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  app.shutdownRequested = true;
  app.flushSocialV2State?.();
  app.flushIdentity?.();
  try { saveState(); } catch (error) { log('退出前保存状态失败:', error?.message ?? error); }
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
  app.shutdownRequested = true;
  try { app.flushSocialV2State?.(); } catch {}
  try { app.flushIdentity?.(); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => {
    // 退出前把攒着的改动都存到硬盘
  try { app.flushSocialV2State?.(); } catch {}
  try { app.flushIdentity?.(); } catch {}
  releaseLock();
});

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
