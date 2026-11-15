// 测试记忆检索找得准不准。
// 检查：短词能搜到、搜不到时有保底、退而求其次时结果一致、
// 不同聊天互相看不到、重建索引快不快。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryIndex, loadSqlite, queryGrams, fuse, lexicalRank } from '../src/memory/index.js';

let failures = 0;
// 跑一个测试用例，出错就记失败
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-index-'));
const DatabaseSync = await loadSqlite();
const now = Date.parse('2026-11-11T12:00:00Z');
// 造一条记忆条目
const item = (id, content, extra = {}) => ({ id, conv_id: 'group:456', kind: 'event', content, subject_uid: '', importance: 3,
  status: 'active', updated_at: new Date(now - 86400_000).toISOString(), expire_at: null, ...extra });
const corpus = [
  item('hike', '小王周六要去爬香山，早上八点出发', { subject_uid: '小王' }),
  item('game', '阿杰每晚十点约人开黑打王者', { subject_uid: '阿杰' }),
  item('cat', '小李家的橘猫叫年糕，上周做了绝育', { subject_uid: '小李' }),
  item('exam', '小陈下个月考研，最近在刷数学真题', { subject_uid: '小陈' }),
  item('food', '大家都说学校东门的麻辣烫比西门的好吃'),
  item('trip', '群里计划寒假去哈尔滨看冰雪大世界'),
  item('job', '老张刚跳槽去了一家做自动驾驶的公司', { subject_uid: '老张' }),
  item('keyboard', '阿杰新买了一把客制化机械键盘，茶轴', { subject_uid: '阿杰' }),
  item('run', '小王每天早上绕操场跑五公里', { subject_uid: '小王' }),
  item('movie', '周五晚上有人组织去看新上映的科幻电影'),
  item('coffee', '小李不喝咖啡，只喝无糖乌龙茶', { subject_uid: '小李', kind: 'preference' }),
  item('promise', '我答应周日提醒大家带水和防晒', { subject_uid: '我', kind: 'commitment', importance: 5 }),
];
// 标注集：问题 → 应召回的条目。
const labelled = [
  ['周六爬香山几点出发', 'hike'], ['今晚开黑吗', 'game'], ['年糕绝育恢复得怎么样', 'cat'], ['考研数学怎么复习', 'exam'],
  ['东门麻辣烫', 'food'], ['寒假去哈尔滨', 'trip'], ['自动驾驶公司招人吗', 'job'], ['机械键盘什么轴', 'keyboard'],
  ['操场跑步', 'run'], ['科幻电影好看吗', 'movie'], ['乌龙茶', 'coffee'], ['提醒带水', 'promise'],
];
// 算一下搜索的命中率和排名
function evaluate(index, conv) {
  let hit = 0, mrr = 0;
  for (const [query, want] of labelled) {
    const rank = index.search(conv, corpus, query, { limit: 5, now }).used_memory_ids.indexOf(want);
    if (rank >= 0) { hit++; mrr += 1 / (rank + 1); }
  }
  return { recall5: hit / labelled.length, mrr: mrr / labelled.length };
}

await test('queryGrams：≥3 字切 3-gram，2 字词保留给 LIKE，去零宽字符', () => {
  const g = queryGrams('今晚开​黑吗 GTA6');
  assert.ok(g.tri.includes('今晚开') && g.tri.includes('gta'));
  assert.ok(g.bi.includes('开黑'));
  assert.deepEqual(queryGrams('开黑').tri, []);
  assert.deepEqual(queryGrams('开黑').bi, ['开黑']);
});

await test('FTS 基线：recall@5 / MRR 记录在案（sqlite 路径）', () => {
  assert.ok(DatabaseSync, '本机 node:sqlite 可用');
  const index = createMemoryIndex({ dir, DatabaseSync });
  assert.equal(index.rebuild('group:456', corpus), true);
  assert.equal(index.search('group:456', corpus, '开黑', { now }).via, 'fts');
  assert.equal(index.search('group:456', corpus, '开黑', { now }).used_memory_ids[0], 'game', '2 字查询走 LIKE 兜底');
  const { recall5, mrr } = evaluate(index, 'group:456');
  console.log(`  FTS 基线：recall@5=${recall5.toFixed(2)} MRR=${mrr.toFixed(2)}（${labelled.length} 组标注 / ${corpus.length} 条记忆）`);
  assert.ok(recall5 >= 0.9 && mrr >= 0.8, `recall@5=${recall5} mrr=${mrr}`);
  index.close();
});

await test('降级：没有 node:sqlite 时内存检索可用，指标不低于阈值', () => {
  const index = createMemoryIndex({ dir: path.join(dir, 'none'), DatabaseSync: null });
  assert.equal(index.rebuild('group:456', corpus), false);
  assert.equal(index.search('group:456', corpus, '开黑', { now }).via, 'memory');
  const { recall5, mrr } = evaluate(index, 'group:456');
  console.log(`  内存降级：recall@5=${recall5.toFixed(2)} MRR=${mrr.toFixed(2)}`);
  assert.ok(recall5 >= 0.9 && mrr >= 0.8);
});

await test('索引文件损坏：不抛错，退回内存检索', () => {
  const badDir = path.join(dir, 'bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'group-456.sqlite'), 'this is not a sqlite database, just garbage bytes '.repeat(50));
  const logs = [];
  const index = createMemoryIndex({ dir: badDir, DatabaseSync, log: (m) => logs.push(m) });
  const result = index.search('group:456', corpus, '爬香山', { now });
  assert.equal(result.via, 'memory');
  assert.equal(result.used_memory_ids[0], 'hike');
  assert.ok(logs.length >= 1);
});

await test('坏索引会被删掉并在重试间隔后重建；运行中被删的索引自动重建', () => {
  const badDir = path.join(dir, 'bad2');
  fs.mkdirSync(badDir, { recursive: true });
  const file = path.join(badDir, 'group-456.sqlite');
  fs.writeFileSync(file, 'garbage '.repeat(200));
  const realNow = Date.now;
  try {
    const index = createMemoryIndex({ dir: badDir, DatabaseSync });
    assert.equal(index.search('group:456', corpus, '爬香山', { now }).via, 'memory');
    assert.equal(index.isBuilt('group:456'), false);
    Date.now = () => realNow() + 11 * 60 * 1000; // 过了重试间隔
    assert.equal(index.isBuilt('group:456'), false);
    assert.equal(index.rebuild('group:456', corpus), true, '坏文件已删，重建成功');
    assert.equal(index.search('group:456', corpus, '爬香山', { now }).via, 'fts');
    fs.rmSync(file);
    assert.equal(index.isBuilt('group:456'), false, '运行中被删：调用方会重建');
    index.close();
  } finally { Date.now = realNow; }
});

await test('索引 / 视图文件名不会逃出目录', async () => {
  const { safeConvName } = await import('../src/store/views.js');
  assert.equal(safeConvName('..'), '_.');
  assert.equal(safeConvName('.'), '_');
  assert.equal(safeConvName('group:456'), 'group-456');
  assert.equal(safeConvName('../../etc'), '_.-..-etc');
});

await test('会话隔离：一会话一文件，别的会话搜不到；drop 删除索引文件', () => {
  const index = createMemoryIndex({ dir, DatabaseSync });
  index.rebuild('group:456', corpus);
  index.rebuild('group:789', []);
  assert.deepEqual(index.search('group:789', [], '爬香山', { now }).used_memory_ids, [], '跨会话泄漏 0');
  assert.ok(fs.existsSync(path.join(dir, 'group-789.sqlite')));
  index.drop('group:789');
  assert.equal(fs.existsSync(path.join(dir, 'group-789.sqlite')), false);
  index.close();
});

await test('融合：过期 / 非 active 不返回；近重复只留一条；无词面命中时按重要性×新近度', () => {
  const items = [
    item('a', '小王周六要去爬香山'), item('b', '小王周六要去爬香山。'),
    item('old', '已过期的事', { expire_at: new Date(now - 1000).toISOString() }),
    item('cand', '候选条目', { status: 'candidate' }),
    item('vip', '很重要的事', { importance: 5 }),
  ];
  const picked = fuse(items, lexicalRank(items, queryGrams('爬香山')), { now }).map((it) => it.id);
  assert.equal(picked.filter((id) => id === 'a' || id === 'b').length, 1);
  assert.ok(!picked.includes('old') && !picked.includes('cand'));
  assert.equal(fuse(items, [], { now })[0].id, 'vip');
});

await test('重建：500 条 < 1 分钟（实际应为毫秒级），且幂等', () => {
  const index = createMemoryIndex({ dir, DatabaseSync });
  const many = [...Array.from({ length: 499 }, (_, i) => item(`m${i}`, `第 ${i} 条记忆：群友${i % 37} 聊到了话题${i % 53} 的细节`)), item('needle', '寒假去哈尔滨看冰雪大世界')];
  const startedAt = Date.now();
  index.rebuild('group:big', many);
  index.rebuild('group:big', many);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 60_000, `重建耗时 ${elapsed}ms`);
  const ids = index.search('group:big', many, '冰雪大世界', { now }).used_memory_ids;
  assert.equal(ids[0], 'needle');
  assert.equal(new Set(ids).size, ids.length, '重建两次不产生重复行');
  index.close();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nFAILED ${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
