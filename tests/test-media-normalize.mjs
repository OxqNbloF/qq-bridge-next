// 检查图片的体积限制和动图抽帧，不联网
//
// 背景：DSH 的图片入口对太大的图会直接报错
// 实测 base64 超过约 447 万字符，也就是原图约 3.2 MiB
// 就会报栈溢出的错，工具结果变成「图片不可用」
// 桥接默认允许 8 MiB，于是 3.2 到 8 MiB 的图必被拒
// DSH 还会把动图压成单帧，模型永远只看到第一帧
//
// 这里验证格式和帧数识别、决策函数，以及真抽帧
// 不联网；没有 ffmpeg 就只跑纯函数并打印跳过
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MEDIA_DEFAULTS,
  describeImage,
  normalizeImageForModel,
  planAnimation,
  planNormalization,
  sniffImage
} from '../src/media-normalize.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let skipped = 0;
// 跑一个测试用例，失败或跳过都记下来
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) {
    if (error?.skip) { skipped++; console.log('SKIP', name, '—', error.skip); return; }
    failures++; console.error('FAIL', name, '—', error?.stack ?? error);
  }
}
// 造一个「跳过」错误，交给上面统一处理
const skip = (why) => Object.assign(new Error(why), { skip: why });

// 固定样例：手写的最小动图，不需要 ffmpeg
// 注意这一段固定 8 字节，少写结束符会被读成 0 帧
const GIF_HEAD = '47494638396101000100800000ffffff000000'; /* GIF89a 头 + 1×1 像素 + 2 色表 */
const GIF_FRAME = '21f9040100000000' + '2c0000000001000100000202440100'; /* 帧控制块 + 图像描述块 */
const GIF_1 = Buffer.from(GIF_HEAD + GIF_FRAME + '3b', 'hex');
const GIF_2 = Buffer.from(GIF_HEAD + GIF_FRAME + GIF_FRAME + '3b', 'hex');
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
// 审计用的假机器人固定返回这张 1×1 图，用来比对原始字节
const FAKE_GATEWAY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=',
  'base64'
);

// 检查本机有没有装 ffmpeg
const hasFfmpeg = (() => {
  try { return spawnSync('ffmpeg', ['-v', 'error', '-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

// 1. 识别格式和帧数（纯函数）
await test('sniffImage 认出 PNG 并读取尺寸/透明通道', async () => {
  const info = sniffImage(PNG_1x1);
  assert.equal(info?.format, 'png');
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.equal(info.alpha, true);
  assert.equal(info.animated, false);
});

await test('sniffImage 数出 GIF 帧数（1 帧 / 2 帧）', async () => {
  assert.equal(sniffImage(GIF_1)?.frames, 1);
  assert.equal(sniffImage(GIF_1)?.animated, false);
  const two = sniffImage(GIF_2);
  assert.equal(two?.frames, 2, '两帧 GIF 必须数成 2 帧');
  assert.equal(two?.animated, true, '两帧 GIF 必须标记为动图');
  assert.equal(two?.format, 'gif');
});

await test('sniffImage 对未知/垃圾字节返回 null（不瞎猜）', async () => {
  assert.equal(sniffImage(Buffer.from('this is not an image at all')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  // 只有开头没有尺寸信息的假 JPEG，认不出就返回 null
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

await test('describeImage 摘要含帧数（日志与提示共用）', async () => {
  assert.match(describeImage(GIF_2), /动图 2 帧/);
  assert.match(describeImage(PNG_1x1), /png 1×1/);
});

// 2. 决策函数
await test('planNormalization：小图原样放行（零额外延迟）', async () => {
  const info = { format: 'jpeg', width: 800, height: 600, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(info, 120 * 1024, MEDIA_DEFAULTS), null);
});

await test('planNormalization：超字节或超长边 ⇒ shrink', async () => {
  const small = { format: 'jpeg', width: 800, height: 600, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(small, 2 * 1024 * 1024, MEDIA_DEFAULTS)?.action, 'shrink');
  const big = { format: 'jpeg', width: 4000, height: 3000, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(big, 300 * 1024, MEDIA_DEFAULTS)?.action, 'shrink', '长边超限也要压');
});

await test('planNormalization：动图 ⇒ animate（不论体积）', async () => {
  const info = { format: 'gif', width: 320, height: 300, frames: 48, durationMs: 4000, animated: true, alpha: true };
  assert.equal(planNormalization(info, 50 * 1024, MEDIA_DEFAULTS)?.action, 'animate');
});

await test('planNormalization：认不出格式且超大 ⇒ reject（不发注定被 DSH 丢掉的字节）', async () => {
  const plan = planNormalization(null, 4 * 1024 * 1024, MEDIA_DEFAULTS);
  assert.equal(plan?.action, 'reject');
});

await test('planNormalization：上限有硬顶（config 写再大也压到 DSH 炸栈线下沿）', async () => {
  const plan = planNormalization(null, 5 * 1024 * 1024, { maxModelBytes: 100 * 1024 * 1024 });
  assert.equal(plan?.action, 'reject');
  const huge = { format: 'jpeg', width: 9000, height: 9000, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.ok(planNormalization(huge, 9 * 1024 * 1024, { maxModelBytes: 100 * 1024 * 1024 }).maxBytes <= 3 * 1024 * 1024);
});

await test('planAnimation：48 帧/4s ⇒ 3×2、fps≈1.5', async () => {
  const layout = planAnimation({ frames: 48, durationMs: 4000 }, MEDIA_DEFAULTS);
  assert.equal(layout.cols, 3);
  assert.equal(layout.rows, 2);
  assert.equal(layout.sampleFrames, 6);
  assert.ok(Math.abs(layout.fps - 1.5) < 1e-6);
});

await test('planAnimation：帧数少于目标时全用（不填充垃圾格）', async () => {
  const layout = planAnimation({ frames: 3, durationMs: 300 }, MEDIA_DEFAULTS);
  assert.equal(layout.sampleFrames, 3);
  assert.equal(layout.cols * layout.rows, 3);
});

await test('planAnimation：时长未知时按每帧 100ms 估算（不会 fps=NaN）', async () => {
  const layout = planAnimation({ frames: 10, durationMs: 0 }, MEDIA_DEFAULTS);
  assert.ok(Number.isFinite(layout.fps) && layout.fps > 0, `fps=${layout.fps}`);
});

// 3. 主入口：不做多余的活
await test('normalizeImageForModel：小 PNG 原样返回（不 spawn ffmpeg、不改字节）', async () => {
  const out = await normalizeImageForModel(PNG_1x1, 'image/png', MEDIA_DEFAULTS);
  assert.equal(out.ok, true);
  assert.equal(out.buffer, PNG_1x1, '应当返回同一个 buffer 引用（零拷贝放行）');
  assert.equal(out.note, '');
});

await test('normalizeImageForModel：enabled=false 直接放行（应急开关）', async () => {
  const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
  const out = await normalizeImageForModel(big, 'image/png', { ...MEDIA_DEFAULTS, enabled: false });
  assert.equal(out.ok, true);
  assert.equal(out.buffer, big);
});

await test('normalizeImageForModel：压不动的垃圾字节 ⇒ ok:false 且给出原因', async () => {
  const junk = Buffer.alloc(4 * 1024 * 1024, 0x41); /* 认不出格式，还超过上限 */
  const out = await normalizeImageForModel(junk, 'image/jpeg', MEDIA_DEFAULTS);
  assert.equal(out.ok, false);
  assert.match(out.error, /上限|压不到/);
});

// 4. 真 ffmpeg：抽帧拼图与缩小图片（没装就跳过）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-media-test-'));
// 调一次 ffmpeg 命令
const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });

await test('真实动图 → 抽帧拼图（单张 JPEG + 帧数说明）', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const gif = path.join(tmp, 'anim.gif');
  const made = ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-vf',
    'split[a][b];[a]palettegen[p];[b][p]paletteuse', gif]);
  if (made.status !== 0) throw skip('ffmpeg 生成夹具失败');
  const src = fs.readFileSync(gif);
  const info = sniffImage(src);
  assert.ok(info.frames >= 8, `应当识别出多帧，实际 ${info.frames}`);

  const out = await normalizeImageForModel(src, 'image/gif', { ...MEDIA_DEFAULTS, tmpDir: tmp });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'image/jpeg', '拼图必须是模型能吃的单帧 JPEG');
  assert.equal(sniffImage(out.buffer)?.frames, 1, '拼图结果不能再是动图');
  assert.match(out.note, /动图 \d+ 帧/);
  assert.match(out.note, /网格/);
  const strip = sniffImage(out.buffer);
  assert.ok(strip.width > 160, `拼图应当比单帧宽（${strip.width}）`);
  assert.ok(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
});

await test('真实大图（3000×2000）→ 降采样到长边上限以内', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const jpg = path.join(tmp, 'big.jpg');
  const made = ff(['-f', 'lavfi', '-i', 'testsrc2=size=3000x2000:rate=1:duration=1', '-frames:v', '1', '-q:v', '2', jpg]);
  if (made.status !== 0) throw skip('ffmpeg 生成夹具失败');
  const src = fs.readFileSync(jpg);
  assert.ok(src.length > 200 * 1024, `夹具应当够大（${src.length}）`);

  const out = await normalizeImageForModel(src, 'image/jpeg', { ...MEDIA_DEFAULTS, tmpDir: tmp });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'image/jpeg');
  const info = sniffImage(out.buffer);
  assert.ok(Math.max(info.width, info.height) <= MEDIA_DEFAULTS.maxLongEdge,
    `长边应 ≤ ${MEDIA_DEFAULTS.maxLongEdge}，实际 ${info.width}×${info.height}`);
  assert.ok(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
  assert.match(out.note, /→/);
});

await test('抽帧失败（ffmpeg 超时/不可用）也不崩：退回首帧 + 说明', async () => {
  // 注意不能靠把 ffmpeg 路径指到不存在来模拟「没装」
  // 因为找不到会回退去系统路径里找，这是已有的行为
  // 这里用 1 毫秒超时让它必然失败，验证失败时不崩
  const out = await normalizeImageForModel(GIF_2, 'image/gif', {
    ...MEDIA_DEFAULTS, tmpDir: tmp, timeoutMs: 1
  });
  assert.equal(out.ok, true);
  assert.equal(out.buffer, GIF_2, '压不动时小图按原样提供（不阻断对话）');
  assert.match(out.note, /只提供首帧/);
});

// 5. 桥接集成：出图会统一格式，收藏表情仍用原始字节
await test('桥接 fetchMediaData 走归一化，且拿得到 mimeType/data', async () => {
  const h = await bridgeHarness();
  try {
    const out = await h.fetchMediaData([{ kind: 'image', file: 'fixture.png' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].mimeType, 'image/png');
    assert.ok(out[0].data && out[0].data.length > 0);
  } finally { await h.close(); }
});

await test('桥接 resolveMediaList（一代内联）同样出图', async () => {
  const h = await bridgeHarness();
  try {
    const parts = await h.resolveMediaList([{ kind: 'image', file: 'fixture.png' }]);
    const image = parts.find((p) => p.type === 'image');
    assert.ok(image, '应当产出一个 image part');
    assert.equal(image.mediaType, 'image/png');
  } finally { await h.close(); }
});

await test('fetchOneBotImage 仍返回**原始字节**（收藏表情不能被降采样/拼图）', async () => {
  const h = await bridgeHarness();
  try {
    const raw = await h.fetchOneBotImage({ kind: 'image', file: 'fixture.png' });
    assert.ok(raw?.buffer);
    // 假机器人回的 1×1 图原样返回，字节一致就没重编码
    assert.equal(raw.buffer.length, FAKE_GATEWAY_PNG.length);
    assert.deepEqual(raw.buffer, FAKE_GATEWAY_PNG);
  } finally { await h.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  failures=${failures} skipped=${skipped}`);
if (failures) process.exit(1);
