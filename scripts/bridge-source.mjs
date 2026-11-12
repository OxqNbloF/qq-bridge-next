// 把桥接的源码文件按顺序拼成一大段文本，给按源码文本做断言的测试用。
// 拼接时会把 rq. / b. 前缀去掉，让断言写起来和以前一样。
// bridge.js 排在最前，其余文件按路径排序。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOVED_DIRS = ['infra', 'gateway', 'inbound', 'conversations', 'dsh', 'features', 'store', 'policy'];

// 把一个文件夹里的 .js 文件全找出来
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (/\.js$/.test(e.name) ? [full] : []);
  });
}

// 列出要拼进来的所有源码文件
export function bridgeSourceFiles() {
  return [path.join(ROOT, 'src', 'bridge.js'), path.join(ROOT, 'src', 'app.js'), ...MOVED_DIRS.flatMap((d) => walk(path.join(ROOT, 'src', d))).sort()];
}

// 读出拼好的源码文本，默认去掉 rq. 和 b. 前缀
export function readBridgeSource({ stripAccessors = true } = {}) {
  const text = bridgeSourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  return stripAccessors ? text.replace(/(?<![\w$.])(?:rq|b)\./g, '') : text;
}
