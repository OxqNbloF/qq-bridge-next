// 守护进程入口
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');

if (!fs.existsSync(CONFIG_PATH)) {
  const example = path.join(ROOT, 'config.example.json');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, CONFIG_PATH);
    console.log(`未发现 config.json，已从 config.example.json 生成默认配置。`);
  }
}

const app = createBridgeApp({
  rootDir: ROOT,
  configPath: CONFIG_PATH,
  dataDir: DATA_DIR,
  logger: (line) => console.log(line),
});

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const info = await app.start({ connectOneBot: true });
console.log(`控制台访问令牌文件: ${path.join(DATA_DIR, 'console.token')} (len=${info.console.token.length})`);
