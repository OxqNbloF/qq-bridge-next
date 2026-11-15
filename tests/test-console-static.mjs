// 不用浏览器也能检查控制台页面结构对不对
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 发语音工具在仓库上一级；先看它在不在，不在就跳过
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'features', 'console', 'web', 'console.html'), 'utf8');

let bad = 0;
// 检查一项，记下失败数并打印结果
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages), 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(tools.includes('sendVoice'), 'sendVoice 开关存在', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');

console.log('## 语音面板接线');
ok(/const headers = body \|\| \(method && method !== 'GET'\) \? \{'content-type':'application\/json'\} : \{\};/.test(html), 'api() 为无请求体的非 GET 请求设置 JSON content-type');
ok(/api\(`\/api\/console\/gate\/member-policy\/\$\{encodeURIComponent\(gatePolicy\.group\.slice\(6\)\)\}\/members\/\$\{encodeURIComponent\(qq\)\}\?confirm=true(?:\$\{expectedQuery\})?`, 'DELETE'\)/.test(html), '门禁成员删除使用无请求体 DELETE');
console.log('## 门禁策略面板接线');
for (const id of ['gateGroup', 'gatePolicyLoad', 'gatePolicySave', 'gatePolicyExport', 'gatePolicyCsv', 'gatePolicyEntries', 'gatePolicyImport', 'gatePolicyDryRun', 'gatePolicyImportCommit', 'gatePolicyStatus', 'gatePolicyImportStatus']) {
  ok(ids.includes(id), `门禁面板元素 ${id}`);
}
for (const selector of ["getElementById('gatePolicyLoad').addEventListener", "getElementById('gatePolicySave').addEventListener", "getElementById('gatePolicyCsv').addEventListener", "getElementById('gatePolicyImportCommit').addEventListener"]) {
  ok(html.includes(selector), `门禁面板事件已绑定：${selector}`);
}
ok(/gatePolicyEntries'\)\.innerHTML = .*esc\(entry\.qq\)/s.test(html), '成员列表渲染转义 QQ 等动态内容');
ok(html.includes('/api/console/gate/member-policy/export?format=csv') && html.includes('/api/console/gate/member-policy/import'), 'JSON/CSV 导出和导入路径已接入');
ok(/gatePolicy\.entries\.some\(\(entry\) => entry\.qq === qq\)/.test(html), '添加成员前检查重复 QQ');
ok(/input\.group && input\.group !== gatePolicy\.group/.test(html), '导入前校验 JSON 群号与当前目标一致');
ok(/gateV2 未开启，策略暂不生效/.test(html), 'gateV2 关闭时提示策略不会生效');
ok(/setTimeout\(\(\) => URL\.revokeObjectURL\(link\.href\), 0\)/.test(html), 'CSV 下载完成后延迟释放对象 URL');
ok(/api\('\/api\/console\/gate\/member-policy\/export\?format=csv[^\n]*, 0, true\)/.test(html), 'CSV 导出复用控制台令牌重试');
ok(/id="voiceRefreshBtn"/.test(html) && /getElementById\('voiceRefreshBtn'\)\.addEventListener/.test(html), '刷新按钮已绑定事件');
ok(/getElementById\('voiceSendBtn'\)\.addEventListener/.test(html), '试发按钮已绑定事件');
ok(/api\('\/api\/console\/voice\/list/.test(html), '面板调用 /api/console/voice/list（操作者通道，无需 key）');
ok(/api\('\/api\/console\/voice\/send'/.test(html), '面板调用 /api/console/voice/send');
ok(/typeof loadVoiceLibrary === 'function'|async function loadVoiceLibrary/.test(html), 'loadVoiceLibrary 已定义');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一段查的是发语音工具自己的页面，仓库里没有
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/console/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/agent/voices'"), 'fixture mock 了 /api/agent/voices');
ok(fixture.includes("case '/api/console/voice/send'"), 'fixture mock 了 /api/console/voice/send');
ok(fixture.includes("const policyBase = '/api/console/gate/member-policy'"), 'fixture 覆盖门禁策略 API');
ok(fixture.includes("path === `${policyBase}/import`"), 'fixture 覆盖门禁策略导入');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
