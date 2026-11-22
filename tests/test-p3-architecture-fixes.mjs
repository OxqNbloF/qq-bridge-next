// 阶段 4（P3）工具清单单一来源、去重、配置模板对齐与工程化回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOCIAL_V2_TOOLS,
  SOCIAL_V2_TOOL_FLAGS,
  SOCIAL_V2_TOOL_PROMPT_MAP,
  STICKER_TOOL_FLAGS,
} from '../src/policy/tool-defaults.js';
import { presetPromptWarnings } from '../src/preset-prompt.js';
import { synchronizePreset } from '../src/preset-sync.js';
import { roleCharStats } from '../src/role-card.js';
import { createMemberPolicyStore } from '../src/store/member-policy.js';
import { syncConfigAliases } from '../src/infra/legacy-config.js';
import { loadConfig } from '../src/infra/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test('tool-defaults: 单一清单完整覆盖 getGroupMembers、PROMPT_MAP 与 config.example.json 对齐', async () => {
  assert.equal(DEFAULT_SOCIAL_V2_TOOLS.getGroupMembers, true);
  assert.deepEqual(
    Object.keys(SOCIAL_V2_TOOL_PROMPT_MAP).sort(),
    [...SOCIAL_V2_TOOL_FLAGS].sort(),
    'SOCIAL_V2_TOOL_PROMPT_MAP 必须与 DEFAULT_SOCIAL_V2_TOOLS 键集完全一致'
  );
  for (const flag of STICKER_TOOL_FLAGS) {
    assert.ok(Object.hasOwn(DEFAULT_SOCIAL_V2_TOOLS, flag), `STICKER_TOOL_FLAGS 中的 ${flag} 必须在默认表里`);
  }
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(example.modes.reserved2.tools).sort(),
    [...SOCIAL_V2_TOOL_FLAGS].sort(),
    'config.example.json 的 modes.reserved2.tools 应与 DEFAULT_SOCIAL_V2_TOOLS 完全一致'
  );
  assert.equal(example.pricing, null, 'config.example.json 不应把虚构的 my-relay-model 注入生产价目表');
  // 确认 config.example.json 能直接通过 loadConfig 校验
  const loaded = loadConfig({
    configFile: path.join(ROOT, 'config.example.json'),
    readJsonSafe: () => example,
    discoverDshLaunchToken: () => '',
  });
  assert.equal(loaded.socialV2.tools.getGroupMembers, true);
});

await test('preset-prompt & preset-sync: v1 告警不误报 v2 段落，CRLF 换行不触发假变更', async () => {
  const v1Text = '基础说明\n群友没有管理权限\n角色扮演由系统注入\n';
  assert.deepEqual(presetPromptWarnings(v1Text, 'v1'), [], 'v1 提示词不应报缺少二代段落警告');
  assert.ok(presetPromptWarnings(v1Text, 'v2').length >= 1, 'v2 提示词缺少二代段落时仍应告警');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sync-'));
  try {
    const srcFile = path.join(tmp, 'src.yml');
    const dstFile = path.join(tmp, 'dst.yml');
    fs.writeFileSync(srcFile, 'a: 1\nb: 2\n', 'utf8');
    fs.writeFileSync(dstFile, 'a: 1\r\nb: 2\r\n', 'utf8');
    let writes = 0;
    const res = synchronizePreset('qq-chat', dstFile, {
      knownPresetName: () => true,
      sourceFor: () => srcFile,
      renderPatch: () => '',
      writeText: () => { writes += 1; },
    });
    assert.equal(res.synced, true);
    assert.equal(res.changed, false, '仅 CRLF/LF 差异不应判为变更');
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('role-card: roleCharStats 单次解析结果准确', async () => {
  const md = '# 公共\n你好\n## 规则 [一代]\n空格分条\n## 工具 [二代]\nqq_send_message\n';
  const stats = roleCharStats(md);
  assert.equal(stats.total, md.length);
  assert.ok(stats.common > 0 && stats.v1Only > 0 && stats.v2Only > 0);
  assert.ok(stats.v1 > stats.common && stats.v2 > stats.common);
});

await test('member-policy: deepFreeze 冻结规则里的 aliases 数组防调用方意外篡改', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-mp-'));
  try {
    const store = createMemberPolicyStore({
      MEMBER_POLICY_FILE: path.join(tmp, 'member-policy.json'),
      cfg: { architecture: { gateV2: true } },
      currentMode: 'reserved2',
      log() {},
      appendActivity() {},
    });
    store.loadMemberPolicy();
    store.setMemberRule('group:456', '123', { flags: { respond: true }, aliases: ['小王'] }, 'test');
    const snap = store.memberPolicySnapshot();
    const aliases = snap.policy.groups['group:456'].rules['123'].aliases;
    assert.equal(Object.isFrozen(aliases), true, 'aliases 数组也应被深度冻结');
    assert.throws(() => aliases.push('篡改'), TypeError);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('legacy-config: syncConfigAliases 补建缺失父对象不抛 TypeError', async () => {
  const out = syncConfigAliases({ social: { enabled: true }, archive: { enabled: true } });
  assert.equal(out.modes.reserved.enabled, true);
  assert.equal(out.memory.archive.enabled, true);
  assert.equal(out.social, undefined);
  assert.equal(out.archive, undefined);
});

await test('package.json & jsconfig.json: 标准 test 脚本、锁死 @snowluma 精确版本与 jsconfig 合法', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'npm run test:audit');
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@snowluma/sdk']), '@snowluma/sdk 应锁死精确版本');
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@snowluma/mcp']), '@snowluma/mcp 应锁死精确版本');
  const jsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'jsconfig.json'), 'utf8'));
  assert.equal(jsconfig.compilerOptions.module, 'NodeNext');
});

console.log(`\n✅ test-p3-architecture-fixes: ${passed} 项全部通过`);
