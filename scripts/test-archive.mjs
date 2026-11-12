// 消息池回归：重复写只留一行、崩溃不粘行、撤回折叠
// 还查状态文件版本号、隐私删除、保留期清理
// 全部用临时目录跑，不碰真实数据
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessageArchive, convDirName, localDay } from '../src/store/archive.js';
import { migrateDocument, FutureSchemaError, SCHEMA_VERSIONS } from '../src/store/schema.js';
import { createAppContext } from '../src/app-context.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
// 跑一条检查，失败就记一次并打印
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}
// 建一个临时目录放测试数据
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-archive-'));
const DAY = 86400000;

await test('append is idempotent per (conv_id, msg_id) and seq is contiguous across restarts', () => {
  const dir = tmp();
  try {
    const a = createMessageArchive({ dir, now: () => Date.UTC(2026, 10, 9, 12) });
    assert.equal(a.append({ conv_id: 'group:0456', msg_id: '1', text: 'a' }).seq, 1);
    assert.equal(a.append({ conv_id: 'group:456', msg_id: '1', text: 'a' }).duplicate, true, '前导零别名是同一会话');
    assert.equal(a.append({ conv_id: 'group:456', msg_id: '2', text: 'b' }).seq, 2);
    const b = createMessageArchive({ dir, now: () => Date.UTC(2026, 10, 9, 13) });
    assert.equal(b.append({ conv_id: 'group:456', msg_id: '2', text: 'b' }).duplicate, true, '重启后仍去重');
    assert.equal(b.append({ conv_id: 'group:456', msg_id: '3', text: 'c' }).seq, 3, '重启后 seq 接续');
    assert.deepEqual(b.range('group:456').map((r) => r.msg_id), ['1', '2', '3']);
    assert.equal(fs.existsSync(path.join(dir, convDirName('group:456'))), true);
    assert.equal(convDirName('group:456').includes(':'), false, 'Windows 文件名不能含冒号');
    assert.throws(() => a.append({ conv_id: 'guild:1', msg_id: 'x' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('full text is kept verbatim; media keeps metadata only (no url)', () => {
  const dir = tmp();
  try {
    const a = createMessageArchive({ dir });
    const long = '长'.repeat(5000);
    a.append({ conv_id: 'private:7', msg_id: 'm', text: long, media: [{ kind: 'image', file: 'x.png', url: 'https://gchat.qpic.cn/?rkey=SECRET' }] });
    const [rec] = a.range('private:7');
    assert.equal(rec.text.length, 5000);
    assert.deepEqual(rec.media, [{ kind: 'image', file: 'x.png' }]);
    assert.equal(JSON.stringify(rec).includes('SECRET'), false);
    assert.match(rec.hash, /^sha256:[0-9a-f]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('a torn trailing line from a crash is skipped and never glued to the next record', () => {
  const dir = tmp();
  try {
    // 固定一个时间点，让测试结果稳定
    const now = () => Date.UTC(2026, 10, 9, 12);
    createMessageArchive({ dir, now }).append({ conv_id: 'group:1', msg_id: 'a', text: 'ok' });
    const shard = path.join(dir, 'group_1', `${localDay(now())}.jsonl`);
    fs.appendFileSync(shard, '{"v":1,"type":"message","seq":2,"msg_id":"b","te');
    const logs = [];
    const b = createMessageArchive({ dir, now, log: (line) => logs.push(line) });
    assert.equal(b.lastSeq('group:1'), 1);
    assert.equal(b.append({ conv_id: 'group:1', msg_id: 'c', text: 'next' }).seq, 2);
    assert.deepEqual(b.range('group:1').map((r) => r.msg_id), ['a', 'c']);
    assert.ok(logs.some((l) => l.includes('跳过 1 行')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('recall is an appended event folded on read; redact really removes the content', () => {
  const dir = tmp();
  try {
    const a = createMessageArchive({ dir });
    a.append({ conv_id: 'group:1', msg_id: 's', text: '身份证 110101199001011234', nick: '小明', media: [{ kind: 'image', file: 'p' }] });
    a.markRecalled('group:1', 's', { operatorId: '9' });
    const [rec] = a.range('group:1');
    assert.equal(rec.recalled, true);
    assert.equal(a.range('group:1', { includeEvents: true }).length, 2, '撤回是追加的事件');
    assert.equal(a.redact('group:1', 's'), 1);
    assert.equal(a.redact('group:1', 's'), 0, '重复删除幂等');
    const raw = fs.readFileSync(path.join(dir, 'group_1', fs.readdirSync(path.join(dir, 'group_1'))[0]), 'utf8');
    assert.equal(raw.includes('110101199001011234'), false, '原文必须从磁盘消失');
    assert.equal(raw.includes('小明'), false);
    const [after] = a.range('group:1');
    assert.equal(after.redacted, true);
    assert.equal(after.seq, 1, 'seq 保留，游标不受影响');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('shards roll by size within a day and by local date', () => {
  const dir = tmp();
  try {
    let t = Date.UTC(2026, 10, 9, 4);
    const a = createMessageArchive({ dir, now: () => t, maxShardBytes: 400 });
    for (let i = 0; i < 4; i += 1) a.append({ conv_id: 'group:1', msg_id: `d1-${i}`, text: 'x'.repeat(150) });
    t += DAY;
    a.append({ conv_id: 'group:1', msg_id: 'd2', text: 'y' });
    const files = fs.readdirSync(path.join(dir, 'group_1')).sort();
    assert.ok(files.length >= 3, files.join(','));
    assert.ok(files.some((f) => /\.\d+\.jsonl$/.test(f)), '同日分卷');
    assert.deepEqual(a.range('group:1').map((r) => r.seq), [1, 2, 3, 4, 5], '跨分卷读取保持顺序');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('prune respects the compression cursor and always keeps the newest shard', () => {
  const dir = tmp();
  try {
    let t = Date.UTC(2026, 0, 1, 4);
    const a = createMessageArchive({ dir, now: () => t });
    a.append({ conv_id: 'group:1', msg_id: 'old1', text: '1' });
    t += DAY; a.append({ conv_id: 'group:1', msg_id: 'old2', text: '2' });
    t += DAY; a.append({ conv_id: 'group:1', msg_id: 'old3', text: '3' });
    t += 200 * DAY;
    assert.deepEqual(a.prune({ olderThanDays: 90 }), [], '默认游标 0：没有消费者时什么都不删');
    const removed = a.prune({ olderThanDays: 90, cursorFor: () => 1 });
    assert.equal(removed.length, 1, '只删整卷都被游标覆盖的那一卷');
    a.prune({ olderThanDays: 90, cursorFor: () => 99 });
    assert.equal(fs.readdirSync(path.join(dir, 'group_1')).length, 1, '最新一卷永远保留');
    const b = createMessageArchive({ dir, now: () => t });
    assert.equal(b.append({ conv_id: 'group:1', msg_id: 'new', text: 'n' }).seq, 4, 'seq 不回退');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('schema: v0 migrates to current, future versions refuse, invalid versions throw', () => {
  const doc = { sessions: {} };
  const out = migrateDocument('sessions', doc);
  assert.equal(out.from, 0);
  assert.equal(out.doc.schemaVersion, SCHEMA_VERSIONS.sessions);
  assert.throws(() => migrateDocument('sessions', { schemaVersion: 99 }), FutureSchemaError);
  assert.throws(() => migrateDocument('sessions', { schemaVersion: '1' }), /非法/);
  assert.throws(() => migrateDocument('nope', {}), /未登记/);
});

await test('AppContext derives paths from the given root and refuses duplicate stores', () => {
  const ctx = createAppContext({ root: '/fixture/root', cfg: { archive: { enabled: true } } });
  assert.equal(ctx.paths.archive, path.join('/fixture/root', 'state', 'archive'));
  assert.equal(ctx.config('archive').enabled, true);
  assert.deepEqual(ctx.config('missing'), {});
  ctx.register('x', {});
  assert.throws(() => ctx.register('x', {}));
});

// 造一条群消息事件，方便反复使用
const groupEvent = (id, message, extra = {}) => ({
  post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
  user_id: 999, message_id: id, time: 1762687719,
  sender: { nickname: '小明', card: '群名片' }, message, ...extra,
});

await test('bridge: archive is off by default and writes nothing', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '456', groupEvent(1, [{ type: 'text', data: { text: 'hi' } }]), h.cfg);
    assert.equal(h.messageArchive, null);
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'archive')), false);
  } finally { await h.close(); }
});

await test('bridge: enabled archive captures inbound (full text, image-only, dedupe), outbound and recalls', async () => {
  const h = await bridgeHarness({ config: { archive: { enabled: true }, sendDelayMs: 0 } });
  try {
    h.setMode('reserved2');
    const long = '这是一条很长的消息'.repeat(60);
    await h.handleIncoming('group', '456', groupEvent(9001, [
      { type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: long } },
    ]), h.cfg);
    await h.handleIncoming('group', '456', groupEvent(9001, [{ type: 'text', data: { text: long } }]), h.cfg);
    await h.handleIncoming('group', '456', groupEvent(9002, [{ type: 'image', data: { file: 'pic.png', url: 'https://x.invalid/?rkey=SECRET' } }]), h.cfg);
    await h.sendToQQ('group:456', '机器人的回复');
    h.handleRecallNotice({ notice_type: 'group_recall', group_id: 456, message_id: 9002, operator_id: 999 });

    const records = h.messageArchive.range('group:456');
    const inbound = records.filter((r) => r.from === 'user');
    assert.equal(inbound.length, 2, `重复投递只写一行：${JSON.stringify(records.map((r) => r.msg_id))}`);
    assert.ok(inbound[0].text.includes(long), '正文全量，没有 200 字截断');
    assert.equal(inbound[0].at_bot, true);
    assert.equal(inbound[0].nick, '群名片');
    assert.equal(inbound[0].ts.startsWith('2025-11-09') || inbound[0].ts.startsWith('2025-11-10'), true, '使用事件时间');
    assert.deepEqual(inbound[1].media, [{ kind: 'image', file: 'pic.png' }], '纯图片消息也落底账，url 不落盘');
    assert.equal(inbound[1].recalled, true, '撤回折叠');
    const bot = records.filter((r) => r.from === 'bot');
    assert.deepEqual(bot.map((r) => r.text), ['机器人的回复']);
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'archive', 'group_456')), true, 'archive 在 state/ 下（随 state 收紧 ACL）');
  } finally { await h.close(); }
});

await test('bridge: state files are stamped with schemaVersion; newer versions are never overwritten', async () => {
  const future = { schemaVersion: 99, sessions: { 'group:456': 'sess-future' }, sessionPolicies: {}, extraFutureField: true };
  const h = await bridgeHarness({ savedState: future, files: { 'state/social-v2.json': { schemaVersion: 99, paused: false, conversations: {} } } });
  try {
    h.setMode('reserved2');
    assert.equal(h.state.sessions['group:456'], 'sess-future', '仍然读取映射');
    await h.handleIncoming('group', '456', groupEvent(1, [{ type: 'text', data: { text: 'hi' } }]), h.cfg);
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'sessions.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, 99, 'sessions.json 不得被旧程序回写');
    assert.equal(onDisk.extraFutureField, true);
    const social = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    assert.equal(social.schemaVersion, 99, 'social-v2.json 不得被旧程序回写');
  } finally { await h.close(); }

  const h2 = await bridgeHarness();
  try {
    h2.setMode('reserved2');
    await h2.handleIncoming('group', '456', groupEvent(2, [{ type: 'text', data: { text: 'hi' } }]), h2.cfg);
    const social = JSON.parse(fs.readFileSync(path.join(h2.temp, 'state', 'social-v2.json'), 'utf8'));
    assert.equal(social.schemaVersion, SCHEMA_VERSIONS['social-v2'], '新写出的 social-v2.json 带当前版本');
  } finally { await h2.close(); }
});

console.log(failures ? `\n${failures} 项失败` : '\narchive / schema 回归全部通过');
process.exit(failures ? 1 : 0);
