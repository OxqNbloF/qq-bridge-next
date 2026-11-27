// 音频库服务：严格目录白名单隔离 + 扩展名/体积/频次配额校验
import fs from 'node:fs';
import path from 'node:path';

export const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.ogg', '.opus', '.silk', '.amr', '.m4a', '.aac', '.flac']);

export function resolveLibraryAudio(libraryDir, relPath) {
  const base = path.resolve(libraryDir);
  const raw = String(relPath ?? '').trim();
  if (!raw || path.isAbsolute(raw)) {
    throw new Error('音频文件必须使用库内相对路径，禁止绝对路径');
  }
  const target = path.resolve(base, raw);
  if (!target.startsWith(base + path.sep)) {
    throw new Error(`禁止音频路径穿越：${raw}`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new Error(`不支持的音频扩展名：${ext || '(无)'}`);
  }
  return target;
}

export function createAudioVault({ rootDir = process.cwd(), getConfig = () => ({}) } = {}) {
  const minuteMap = new Map();
  const dayMap = new Map();

  function libraryRoot() {
    const dir = String(getConfig()?.audio?.libraryDir || 'data/audio');
    return path.isAbsolute(dir) ? dir : path.resolve(rootDir, dir);
  }

  function listAudio({ limit = 60 } = {}) {
    const dir = libraryRoot();
    if (!fs.existsSync(dir)) return [];
    const results = [];
    const walk = (cur, depth) => {
      if (depth > 3 || results.length >= limit) return;
      for (const entry of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(full);
          results.push({ path: path.relative(dir, full).replace(/\\/g, '/'), name: entry.name, bytes: stat.size });
          if (results.length >= limit) return;
        }
      }
    };
    walk(dir, 0);
    return results;
  }

  function consumeQuota(roomId) {
    const cfg = getConfig()?.audio ?? {};
    const perMin = Math.max(1, Number(cfg.perMinuteCap) || 3);
    const perDay = Math.max(1, Number(cfg.perDayCap) || 20);
    const now = Date.now();
    const recent = (minuteMap.get(roomId) ?? []).filter((ts) => now - ts < 60000);
    if (recent.length >= perMin) return { ok: false, code: 'AUDIO_RATE_LIMITED', error: `每分钟最多发送 ${perMin} 条音频` };
    const dayStr = new Date(now).toISOString().slice(0, 10);
    const dayEntry = dayMap.get(roomId) ?? { day: dayStr, count: 0 };
    if (dayEntry.day !== dayStr) { dayEntry.day = dayStr; dayEntry.count = 0; }
    if (dayEntry.count >= perDay) return { ok: false, code: 'AUDIO_DAILY_CAP', error: `每日最多发送 ${perDay} 条音频` };
    recent.push(now);
    minuteMap.set(roomId, recent);
    dayEntry.count += 1;
    dayMap.set(roomId, dayEntry);
    return { ok: true };
  }

  async function dispatchAudio(roomId, relPath, { transport, egressGuard }) {
    const cfg = getConfig()?.audio ?? {};
    if (cfg.enabled !== true) return { ok: false, code: 'AUDIO_DISABLED', error: '音频发送功能未开启' };
    const gateCheck = egressGuard.inspectAndFormat(roomId, '[语音]');
    if (!gateCheck.ok) return gateCheck;

    const dir = libraryRoot();
    let absPath;
    try { absPath = resolveLibraryAudio(dir, relPath); }
    catch (error) { return { ok: false, code: 'AUDIO_PATH_BLOCKED', error: error.message }; }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { ok: false, code: 'AUDIO_NOT_FOUND', error: `音频文件不存在：${relPath}` };
    }
    const maxBytes = Math.max(1024, Number(cfg.maxBytes) || 20971520);
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) {
      return { ok: false, code: 'AUDIO_TOO_LARGE', error: `音频体积 ${stat.size}B 超出上限 ${maxBytes}B` };
    }
    const quota = consumeQuota(roomId);
    if (!quota.ok) return quota;

    await transport.sendAudio(roomId, absPath);
    return { ok: true, file: path.relative(dir, absPath).replace(/\\/g, '/'), bytes: stat.size };
  }

  return { listAudio, dispatchAudio };
}
