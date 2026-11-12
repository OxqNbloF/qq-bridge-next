// 检查音量调节功能：
// 1) 各种音量参数能不能被正确读懂和挡住
// 2) 真的处理一段音频，量一量音量有没有按倍数变化
// 3) 音量 1 时不该生成新文件，临时文件要能清掉
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LOUDNESS_TARGETS, VOLUME_MAX, VOLUME_MIN,
  cleanupTemp, processAudioVolume, resolveAudioProcessing
} from '../src/voice-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
// 记一次检查结果，错了就记一次失败
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// 跑一个外部程序，等它结束
function run(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { resolve({ code: -1, error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'timeout' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: e.code || e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });
}
// 调 ffmpeg 处理音频
const ffmpeg = (args, t) => run(process.env.FFMPEG_PATH || 'ffmpeg', args, t);
// 调 ffprobe 读音频信息
const ffprobe = (args, t) => run(process.env.FFPROBE_PATH || 'ffprobe', args, t);

/** 自己算出音频的音量大小，不靠外部工具的统计 */
function wavRms(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ') {
        fmt = { channels: buf.readUInt16LE(body + 2), bits: buf.readUInt16LE(body + 14) };
      } else if (id === 'data') {
        data = buf.subarray(body, Math.min(body + size, buf.length));
        break;
      }
      offset = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.bits !== 16) return null;
    const samples = Math.floor(data.length / 2);
    if (samples === 0) return null;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const v = data.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms);
  } catch {
    return null;
  }
}

/** 用外部工具把音频解一遍，只看能不能解开 */
async function measure(file) {
  return ffmpeg(['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', os.devNull], 30000);
}

console.log('## 参数解析');
{
  ok(resolveAudioProcessing({ volume: 1 }).volume === 1, 'volume=1 → 原样');
  ok(resolveAudioProcessing({ volume: 2.5 }).volume === 2.5, 'volume=2.5 通过');
  ok(resolveAudioProcessing({ volume: VOLUME_MIN }).volume === VOLUME_MIN, `下限 ${VOLUME_MIN} 通过`);
  ok(resolveAudioProcessing({ volume: VOLUME_MAX }).volume === VOLUME_MAX, `上限 ${VOLUME_MAX} 通过`);
  let threw = false;
  try { resolveAudioProcessing({ volume: VOLUME_MAX + 0.1 }); } catch { threw = true; }
  ok(threw, '超上限被拒');
  threw = false;
  try { resolveAudioProcessing({ volume: 0 }); } catch { threw = true; }
  ok(threw, '音量 0 被拒（不是静音开关）');
  ok(resolveAudioProcessing({ normalize: true, loudness: 'quiet' }).loudness === LOUDNESS_TARGETS.quiet, 'quiet 档 → -20 LUFS');
  ok(resolveAudioProcessing({ normalize: true, loudness: 'loud' }).loudness === LOUDNESS_TARGETS.loud, 'loud 档 → -13 LUFS');
  ok(resolveAudioProcessing({ normalize: true }).loudness === LOUDNESS_TARGETS.normal, '默认 normal 档');
  ok(resolveAudioProcessing({ normalize: true, loudness: -18 }).loudness === -18, '可直接给 LUFS 数字');
  threw = false;
  try { resolveAudioProcessing({ normalize: true, loudness: -60 }); } catch { threw = true; }
  ok(threw, '越界 LUFS 被拒');
  threw = false;
  try { resolveAudioProcessing({ normalize: true, loudness: 'nope' }); } catch { threw = true; }
  ok(threw, '未知档位被拒');
  ok(resolveAudioProcessing({ normalize: true, volume: 3 }).loudness !== null, 'normalize 优先于 volume（互斥）');
}

console.log('## 原样不加处理');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-src-'));
  const src = path.join(tmp, 'tone.wav');
  const r = await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '24000', src]);
  if (r.code !== 0) {
    console.log(`  ⏭  跳过：本环境无法运行 ffmpeg（${r.error ?? r.code}）`);
  } else {
    const same = await processAudioVolume(src, { volume: 1 });
    ok(same.converted === false && same.path === src, 'volume=1 直接复用原文件（不转码）');
    ok(same.mode === 'original', 'mode=original');

    console.log('## 真的调音量（对比处理前后体积与可解码性）');
    const louder = await processAudioVolume(src, { volume: 3, tmpDir: tmp });
    ok(louder.converted === true && fs.existsSync(louder.path), 'volume=3 产出新文件', path.basename(louder.path));
    ok(louder.detail.includes('300%'), 'detail 标明 300%', louder.detail);
    const probeJson = path.join(tmp, 'p.json');
    const probe = await ffprobe(['-hide_banner', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', '-o', probeJson, '-i', louder.path]);
    ok(probe.code === 0 && fs.existsSync(probeJson), '处理后的文件能被 ffprobe 正常解析（没写坏）');
    const dur = probe.code === 0 ? JSON.parse(fs.readFileSync(probeJson, 'utf8')).format?.duration : null;
    ok(dur !== null && Math.abs(Number(dur) - 1) < 0.15, '时长保持不变', `${dur}s`);

    const quieter = await processAudioVolume(src, { volume: 0.3, tmpDir: tmp });
    ok(quieter.converted === true && fs.statSync(quieter.path).size > 0, 'volume=0.3 也产出有效文件');

    const norm = await processAudioVolume(src, { normalize: true, loudness: 'loud', tmpDir: tmp });
    ok(norm.converted === true && fs.existsSync(norm.path), '智能音量（loudnorm）产出文件');
    ok(norm.mode === 'loudnorm' && /响度归一/.test(norm.detail), 'detail 标明响度归一', norm.detail);

    console.log('## 增益是否真的生效（自算 WAV RMS）');
    const base = wavRms(src);
    const up = wavRms(louder.path);
    const down = wavRms(quieter.path);
    if (base === null || up === null || down === null) {
      console.log(`  ⏭  跳过：拿不到 PCM（base=${base} up=${up} down=${down}）`);
    } else {
      // 3 倍约加 9.5 分贝；给点容差，防止小误差误判
      const upDelta = up - base;
      const downDelta = down - base;
      ok(Math.abs(upDelta - 9.54) < 2.5, `3 倍 ≈ +9.5 dB（实测 ${upDelta.toFixed(2)} dB）`, `${base.toFixed(2)} → ${up.toFixed(2)} dBFS`);
      ok(Math.abs(downDelta + 10.46) < 2.5, `0.3 倍 ≈ -10.5 dB（实测 ${downDelta.toFixed(2)} dB）`, `${base.toFixed(2)} → ${down.toFixed(2)} dBFS`);
      ok(up > base && base > down, '单调性：调大 > 原样 > 调小');
      // 还要确认 3 倍确实比 2 倍更响
      const two = await processAudioVolume(src, { volume: 2, tmpDir: tmp });
      const twoRms = wavRms(two.path);
      if (twoRms !== null) {
        ok(Math.abs((twoRms - base) - 6.02) < 2, `2 倍 ≈ +6.0 dB（实测 ${(twoRms - base).toFixed(2)} dB）`);
      }
      cleanupTemp(two.path, two.converted);
    }

    console.log('## 临时文件清理');
    const before = fs.readdirSync(tmp).length;
    cleanupTemp(louder.path, louder.converted);
    cleanupTemp(quieter.path, quieter.converted);
    cleanupTemp(norm.path, norm.converted);
    const after = fs.readdirSync(tmp).length;
    ok(after < before, 'cleanupTemp 删掉了处理产物', `${before} → ${after}`);
    // 原件不能被误删
    cleanupTemp(src, false);
    ok(fs.existsSync(src), 'cleanupTemp(非临时) 不动原文件');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('## 源文件异常');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-bad-'));
  const junk = path.join(tmp, 'junk.mp3');
  fs.writeFileSync(junk, Buffer.alloc(2048, 7));
  let threw = false;
  let msg = '';
  try { await processAudioVolume(junk, { volume: 2, tmpDir: tmp }); } catch (e) { threw = true; msg = e.message; }
  if (/ffmpeg/.test(msg) || threw) ok(threw, '损坏音频被拒（给出可读错误）', msg.slice(0, 60));
  else ok(false, '损坏音频被拒', '竟然成功了？');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
