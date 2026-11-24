// 不用浏览器也能检查模块化工作台页面与静态资产结构是否正确
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_DEFINITIONS } from '../src/features/console/module-registry.js';
import { SOCIAL_V2_TOOL_FLAGS } from '../src/policy/tool-defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(ROOT, 'src', 'features', 'console', 'web');
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 旧页面清理与严格 CSP 外壳');
ok(!fs.existsSync(path.join(webDir, 'console.html')), '已移除旧 console.html');
ok(!fs.existsSync(path.join(webDir, 'studio.html')), '已移除旧 studio.html');
ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'index.html 无内联 <script>（满足严格 script-src self）');
ok(!/<style[\s>]/i.test(html), 'index.html 无内联 <style>（满足严格 style-src self）');

console.log('## 元素 ID 与视图契约');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'index.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages) && views.length === 7, 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 静态资源完整性');
const expectedAssets = [
  'assets/workbench.css',
  'assets/api.js',
  'assets/schema-form.js',
  'assets/app.js',
  'assets/panels/overview.js',
  'assets/panels/modules.js',
  'assets/panels/sessions.js',
  'assets/panels/gate.js',
  'assets/panels/persona.js',
  'assets/panels/media-tools.js',
  'assets/panels/system.js',
];
for (const rel of expectedAssets) {
  ok(fs.existsSync(path.join(webDir, rel)), `静态资产存在：${rel}`);
}

console.log('## 12 模块注册表与工具覆盖');
ok(MODULE_DEFINITIONS.length === 12, '12 大功能模块全部注册', `共 ${MODULE_DEFINITIONS.length} 个`);
const allPaths = MODULE_DEFINITIONS.flatMap((m) => m.fields.map((f) => f.path));
ok(new Set(allPaths).size === allPaths.length, '全部模块参数路径无重复', `共 ${allPaths.length} 项`);
for (const flag of SOCIAL_V2_TOOL_FLAGS) {
  ok(allPaths.includes(`modes.reserved2.tools.${flag}`), `工具开关已入表：${flag}`);
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
