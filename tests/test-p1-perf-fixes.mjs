// 阶段 2（P1）热路径性能、I/O 与 Token 成本优化回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTokenLedger } from '../src/token-ledger.js';
import { DEFAULT_PRICE_TABLE, isPeakAt } from '../src/model-prices.js';
import { createMemoryIndex, loadSqlite } from '../src/memory/index.js';
import { createMemoryPool } from '../src/store/pool.js';
import { createActivityTailReader } from '../src/features/console/activity.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-p1-'));

test('P1-1 & P1-2: reserved2 唤醒只构建一次提示词（role 计数仅 +1），且常规轮次显著精简静态模板', async () => {
  const h = await bridgeHarness({
    config: {
      role: { injectEveryNWakes: 4, injectDedupeWindowMs: 0 },
      socialV2: { wake: { maxWakePerMinute: 0, maxWakePerHour: 0 }, proactive: { enabled: false } },
    },
    files: {
      'roles/小测试.md': '你是小测试。',
      'state/current-role.json': JSON.stringify({ role: '小测试', mode: 'active' }),
    },
  });
  try {
    h.setReady(true);
    h.setMode('reserved2');
    const key = 'group:456';
    h.appendSocialV2Message(key, '小明', '在吗', '在吗', false, false, 'm1', [], '789');
    const r = await h.sendWakePromptV2(key, 'atMention');
    assert.equal(r?.ok, true);
    const injectState = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'role-inject.json'), 'utf8'));
    assert.equal(injectState[key]?.n, 1, '关闭 8s 去重窗口后，一次唤醒角色注入计数必须仅 +1（不得双倍构建）');

    // 验证常规唤醒（非首轮且非全量角色轮次）比首轮精简
    const st = h.getSocialV2State(key);
    st.bootstrapSent = true;
    const fullPrompt = h.buildWakePromptV2(key, 'bootstrap');
    const lightPrompt = h.buildWakePromptV2(key, 'atMention');
    assert.ok(fullPrompt.includes('【反AI味】'));
    assert.ok(!lightPrompt.includes('【反AI味】'));
    assert.ok(lightPrompt.length < fullPrompt.length - 800, `精简轮次应至少节省 800+ 字（full=${fullPrompt.length}, light=${lightPrompt.length}）`);
  } finally {
    await h.close();
  }
});

test('P1-3: token-ledger 达到 maxLines 后带滞回淘汰，不再每条事件触发全量重写', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'ledger.jsonl');
    let compactCount = 0;
    const realRename = fs.renameSync;
    const origRename = fs.renameSync;
    const ledger = createTokenLedger({
      file,
      priceTable: DEFAULT_PRICE_TABLE,
      resolveKey: () => 'group:100',
      maxLines: 40,
    });
    // 写入一条 baseline + 100 条 sample
    ledger.ingestBaseline({
      sessionId: 's1',
      projection: { asOfSeq: 1, values: { tokenUsage: { inputTokens: 100, outputTokens: 10 } } },
      at: Date.parse('2026-03-02T20:00:00+08:00'),
    });
    let prevCompactedAt = ledger.stats().lastCompactedAt;
    let nowMs = Date.parse('2026-03-02T20:00:00+08:00');
    const ledger2 = createTokenLedger({
      file: path.join(dir, 'ledger2.jsonl'),
      priceTable: DEFAULT_PRICE_TABLE,
      resolveKey: () => 'group:100',
      maxLines: 40,
      now: () => ++nowMs,
    });
    ledger2.ingestBaseline({
      sessionId: 's1',
      projection: { asOfSeq: 1, values: { tokenUsage: { inputTokens: 100, outputTokens: 10 } } },
      at: nowMs,
    });
    prevCompactedAt = ledger2.stats().lastCompactedAt;
    for (let i = 1; i <= 100; i += 1) {
      ledger2.ingestEvent({
        sessionId: 's1',
        event: { seq: i + 10, time: nowMs, type: 'assistant/message', data: { turn: i, step: 1, usage: { inputTokens: 10, outputTokens: 2 } } },
        at: nowMs,
      });
      const cAt = ledger2.stats().lastCompactedAt;
      if (cAt !== prevCompactedAt) {
        compactCount += 1;
        prevCompactedAt = cAt;
      }
    }
    assert.ok(compactCount <= 20, `100 条超出 maxLines=40 应分批压缩而非每条重写（实际压缩 ${compactCount} 次）`);
    assert.ok(ledger2.stats().samples <= 40);
    // 批量快照摄入保持正确累计
    const snapN = ledger.ingestSnapshotRecords({
      sessionId: 's2',
      records: Array.from({ length: 15 }, (_, i) => ({
        type: 'event',
        event: { seq: i + 1, time: nowMs, type: 'assistant/message', data: { turn: i + 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } },
      })),
    });
    assert.equal(snapN, 15);
    assert.equal(isPeakAt(Date.parse('2026-03-02T10:00:00+08:00'), DEFAULT_PRICE_TABLE), true);
    void realRename; void origRename;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-4 & P1-5: SQLite FTS5 WAL/ensureBuilt 跨重启免重建、两字短词命中且 pool.query 支持零拷贝过滤', async () => {
  const dir = mkTmp();
  try {
    const pool = createMemoryPool({ file: path.join(dir, 'pool', 'items.jsonl') });
    pool.update(() => [
      { id: 'e1', kind: 'event', conv_id: 'group:456', content: '阿杰今晚十点约人开黑打王者', subject_uid: '222', status: 'active', importance: 3, updated_at: '2026-11-01T00:00:00Z' },
      { id: 'p1', kind: 'preference', conv_id: 'group:456', content: '小李只喝无糖乌龙茶', subject_uid: '333', status: 'active', importance: 4, updated_at: '2026-11-01T00:00:00Z' },
      { id: 'e2', kind: 'event', conv_id: 'group:789', content: '其他群的消息', subject_uid: '444', status: 'active', importance: 3, updated_at: '2026-11-01T00:00:00Z' },
    ]);
    const refA = pool.query({ kinds: ['event', 'preference'], convId: 'group:456', clone: false });
    const refB = pool.query({ kinds: ['event', 'preference'], convId: 'group:456', clone: false });
    assert.equal(refA.length, 2);
    assert.equal(refA[0], refB[0], 'clone: false 应返回零拷贝对象引用');

    const DatabaseSync = await loadSqlite();
    if (DatabaseSync) {
      const idxDir = path.join(dir, 'index');
      const idx1 = createMemoryIndex({ dir: idxDir, DatabaseSync });
      assert.equal(idx1.ensureBuilt('group:456', refA), true);
      assert.equal(idx1.search('group:456', refA, '开黑').used_memory_ids[0], 'e1');
      idx1.close();

      // 模拟重启后新实例：指纹匹配直接复用，无需重建
      const idx2 = createMemoryIndex({ dir: idxDir, DatabaseSync });
      assert.equal(idx2.isBuilt('group:456'), false);
      assert.equal(idx2.ensureBuilt('group:456', refA), true);
      assert.equal(idx2.isBuilt('group:456'), true);
      assert.equal(idx2.search('group:456', refA, '乌龙茶').used_memory_ids[0], 'p1');
      idx2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-6: activity.js 尾读只截取末尾窗口，正确返回大日志最后 N 行', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'qq-activity.log');
    const lines = Array.from({ length: 4000 }, (_, i) => `[12:00:00] line-${i + 1} ${'x'.repeat(40)}`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const readTail = createActivityTailReader(file);
    const tail = readTail(5).split('\n');
    assert.equal(tail.length, 5);
    assert.ok(tail[0].startsWith('[12:00:00] line-3996 '));
    assert.ok(tail[4].startsWith('[12:00:00] line-4000 '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
