// 程序入口：加载 config.json 并启动 chat-relay 控制面与消息传输层
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function main() {
  const app = createRelayApp({ rootDir: ROOT_DIR });
  const { control } = await app.start({ startTransport: true });
  if (control.secretSource !== 'config') {
    process.stdout.write(`[chat-relay] 控制面板一次性查看密钥 (x-control-secret): ${control.secret}\n`);
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n[chat-relay] 收到 ${signal}，正在清理 Socket 与持久化状态...\n`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[chat-relay] 启动失败: ${err?.stack || err}\n`);
  process.exit(1);
});
