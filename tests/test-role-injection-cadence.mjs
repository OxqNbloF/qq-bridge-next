// 检查角色卡的推送节奏，不连 DSH 也不发 QQ
// 1. 第一次唤醒要带完整角色卡，不然角色没生效
// 2. 以后每若干次才带一次全卡，中间只提醒一行
// 3. 角色卡文件改了要马上重新带全卡
// 4. 同一次唤醒里重复生成不能重复计数
// 5. 没启用角色时不能凭空出现角色段落
// 6. 设成每次都全带时，就每次都带全卡
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const CARD_V1 = '# 测试人格\n\n- 性格：偏执、只认一个称呼。\n- 称呼：叫他「宝宝」。\n';
const CARD_V2 = '# 测试人格\n\n- 性格：偏执、只认一个称呼。\n- 称呼：叫他「老板」。\n';

let failures = 0;
// 跑一个测试用例，失败就记下来
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

// 关掉去重窗口，才能连着调用来验证节奏
const baseConfig = { role: { injectDedupeWindowMs: 0 } };
// 造一套基础的角色卡配置文件
const baseFiles = () => ({
  'roles/测试人格.md': CARD_V1,
  'state/current-role.json': JSON.stringify({ role: '测试人格', mode: 'active' })
});

await test('首次唤醒注入完整角色卡正文', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: baseFiles() });
  try {
    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【当前角色】测试人格/);
    assert.match(prompt, /叫他「宝宝」/, '首次唤醒必须带正文，否则模型只知道名字');
    assert.match(prompt, /【角色卡结束】/, '全卡注入应有明确边界，避免和后面的规则混淆');
  } finally { await h.close(); }
});

await test('每 N 次唤醒才重复全量，中间只给一行提醒', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: baseFiles() });
  try {
    const rounds = [];
    for (let i = 1; i <= 5; i += 1) {
      const prompt = h.buildWakePromptV2(KEY, 'atMention');
      rounds.push({
        i,
        hasCard: /叫他「宝宝」/.test(prompt),
        hasRole: /【当前角色】测试人格/.test(prompt),
      });
    }
    assert.deepEqual(rounds.map((r) => r.hasCard), [true, false, false, false, true],
      '默认 injectEveryNWakes=4：第 1 次全量，第 5 次再全量');
    for (const r of rounds) assert.ok(r.hasRole, `第 ${r.i} 次唤醒都应点名当前角色`);
    const stub = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(stub, /角色卡已在本会话前面完整给过/, '非全量轮次应给一行提醒');
  } finally { await h.close(); }
});

await test('卡内容变化后立刻重新全量（不等计数轮到）', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: baseFiles() });
  try {
    const first = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(first, /叫他「宝宝」/);
    const second = h.buildWakePromptV2(KEY, 'atMention');
    assert.doesNotMatch(second, /叫他「宝宝」/, '第二次应走提醒，证明计数生效');

    // 改角色卡：写新内容并把修改时间往后调
    const file = path.join(h.temp, 'roles/测试人格.md');
    fs.writeFileSync(file, CARD_V2);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);

    const third = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(third, /叫他「老板」/, '换卡后必须立刻注入新正文');
  } finally { await h.close(); }
});

await test('同一次唤醒的重复构建不重复消费计数（默认 8s 去重）', async () => {
  const h = await bridgeHarness({ files: baseFiles() }); /* 用默认的去重窗口 */
  try {
    const a = h.buildWakePromptV2(KEY, 'atMention');
    const b = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(a, /叫他「宝宝」/);
    assert.match(b, /叫他「宝宝」/, '8s 内的第二次构建应沿用「全量」判定，不能立刻降级成提醒');
  } finally { await h.close(); }
});

await test('未启用角色时不注入【当前角色】段', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: { 'state/current-role.json': JSON.stringify({ role: null, mode: 'active' }) } });
  try {
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'atMention'), /【当前角色】/);
    assert.doesNotMatch(h.buildWakeReminderPromptV2(KEY), /【当前角色】/);
  } finally { await h.close(); }
});

await test('injectEveryNWakes=1 时退回每次全量', async () => {
  const h = await bridgeHarness({ config: { role: { injectDedupeWindowMs: 0, injectEveryNWakes: 1 } }, files: baseFiles() });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.match(h.buildWakePromptV2(KEY, 'atMention'), /叫他「宝宝」/, `第 ${i + 1} 次都应全量`);
    }
  } finally { await h.close(); }
});

await test('计数落盘到 state/role-inject.json（不写进 social-v2.json）', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: baseFiles() });
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    const file = path.join(h.temp, 'state/role-inject.json');
    assert.ok(fs.existsSync(file), '计数应写入独立文件');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(store[KEY] && typeof store[KEY].n === 'number', '计数应按会话 key 记录');
    assert.match(String(store[KEY].sig), /测试人格:/, '签名应包含角色名');
  } finally { await h.close(); }
});

// 7. 会话重建后记忆是空的，必须马上重新带全卡
// 不能因为计数到第 3 轮就只提醒一行
await test('新 DSH 会话立刻重新全量，不沿用旧会话的计数', async () => {
  const h = await bridgeHarness({ config: baseConfig, files: baseFiles() });
  try {
    const first = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(first, /叫他「宝宝」/, '前置条件：第 1 次是全卡');
    const second = h.buildWakePromptV2(KEY, 'atMention');
    assert.doesNotMatch(second, /叫他「宝宝」/, '前置条件：第 2 次是提醒');

    // 模拟换会话：新会话 id 是另一个 qqb-…
    h.state.sessions[KEY] = 'qqb-g-456-' + 'c'.repeat(32);
    const afterReset = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(afterReset, /叫他「宝宝」/, '新会话必须重新全量注入人格卡');
    assert.match(afterReset, /【角色卡结束】/, '全卡必须有明确边界');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n角色卡注入节奏回归：全部通过');
}
