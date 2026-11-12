// 只读检查 qq-mode-console 插件的写法对不对，不启动 DSH。
// 下面几条缺一条，网页上的设置就读不到也写不了：
// ① 配置里的 id 必须正好是 qq-mode
// ② 插件必须导出 Config，而且是能用的格式
// ③ Config 里至少要有一个标了 volatile 的字段
// ④ 插件不能再调用新版已删掉的 settings.register()
// 真实 DSH 上的完整验证由 verify-dsh-022-adaptation.mjs 负责。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-mode-console');
const NS = 'qq-mode';

const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
const source = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');

// 不同版本的设置库返回的值有两种样子：直接是值，或包一层要点 .get() 取。
// 这里统一取出真正的值再做比较。
const unwrapValue = (value) => (
  value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
);

test('插件导出 name / inject / Config / apply', () => {
  assert.equal(mod.name, 'qq-mode-console');
  assert.deepEqual(mod.inject, ['settings'], 'inject 必须声明 settings，命名空间才随 settings seam 就绪');
  assert.ok(mod.Config, '必须导出 Config —— 0.2.0 里这就是命名空间的 schema 来源');
  assert.equal(typeof mod.apply, 'function');
});

test('cordis.patch.yml 的 entry id 恰好等于命名空间名', () => {
  // ① 最容易写错：id 写成插件包名就会找不到配置
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(ids.includes(NS), `patch 里应有 id: ${NS}，实际 ${ids.join(', ')}`);
  assert.ok(!ids.includes('qq-mode-console'), 'entry id 不应是插件包名');
});

test('Config 是可用的 schemastery schema，且带 volatile 字段', () => {
  const resolved = mod.Config({});
  assert.equal(unwrapValue(resolved.mode), 'reserved2', 'Config 默认 mode 应为 reserved2');

  // ③ 检查有没有标记 volatile 的字段。
  // 设置格式里字段是间接存的，要先按编号找到真正的位置。
  const json = mod.Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  const volatileFields = [];
  for (const [key, node] of Object.entries(root.dict ?? {})) {
    if (refs[String(node)]?.meta?.volatile === true) volatileFields.push(key);
  }
  assert.ok(
    volatileFields.length > 0,
    'Config 至少一个字段必须带 .extra(\'volatile\', true)，否则 settings 写入会抛 "has no volatile fields"；'
    + `实际 volatile 字段：${volatileFields.join(', ') || '(无)'}`,
  );
  assert.ok(volatileFields.includes('mode'), `mode 字段应带 volatile，实际：${volatileFields.join(', ')}`);
});

test('schema 接受全部规范/历史 mode 拼写，拒绝非法值', () => {
  for (const mode of ['chat', 'closed-agent', 'reserved', 'reserved2', 'simulation']) {
    assert.equal(unwrapValue(mod.Config({ mode }).mode), mode, `${mode} 应被接受`);
  }
  assert.throws(() => mod.Config({ mode: 'bogus' }), '非法 mode 必须被拒绝');
});

test('不再调用 0.2.0 已删除的 ctx.settings.register', () => {
  // 只看代码，不看注释（注释里可能会提到旧写法）
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(
    !/settings\s*\.\s*register\s*\(/.test(code),
    'ctx.settings.register() 在 DSH 0.2.0 已不存在：调用它会让 apply 抛 TypeError。'
    + '命名空间由 entry id + 导出的 Config 推导，无需注册。',
  );
  // 也不能调用 configure()，它会把默认设置页关掉
  assert.ok(!/settings\s*\.\s*configure\s*\(/.test(code), 'apply 不应调用 settings.configure()');
});

test('apply 在缺少 settings 服务时也不抛（静默降级）', () => {
  assert.doesNotThrow(() => mod.apply({}), 'apply 必须容忍没有 ctx.settings 的环境');
});
