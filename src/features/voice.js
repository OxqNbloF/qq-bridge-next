// 本地语音库服务：严格目录隔离（禁止路径穿越与库外绝对路径）+ 频次与体积预算校验
import fs from 'node:fs';
import path from 'node:path';

export const AUDIO_EXTS = Object.freeze(['.mp3', '.wav', '.ogg', '.opus', '.silk', '.amr', '.m4a', '.aac', '.flac']);

export function safeJoinLibrary(voiceDir, relPath) {
  const base = path.resolve(voiceDir);
  const raw = String(relPath ?? '').trim();
  if (!raw || path.isAbsolute(raw)) {
    throw new Error('语音文件必须使用库内相对路径，禁止绝对路径');
  }
  const target = path.resolve(base, raw);
  if (!target.startsWith(base + path.sep)) {
    throw new Error(`禁止语音路径穿越：${raw}`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) {
    throw new Error(`不支持的音频扩展名：${ext || '(无)'}`);
  }
  return target;
}

export function createVoiceService({ rootDir = process.cwd(), getConfig = () => ({}) } = {}) {
  const minuteMap = new Map(); // convKey -> timestamps[]
  const dayMap = new Map();    // convKey -> { day, count }

  function resolveVoiceDir() {
    const configured = String(getConfig()?.voice?.dir || 'data/voices');
    return path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
  }

  function listVoices({ limit = 60 } = {}) {
    const dir = resolveVoiceDir();
    if (!fs.existsSync(dir)) return [];
    const results = [];
    const walk = (cur, depth) => {
      if (depth > 3 || results.length >= limit) return;
      for (const entry of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && AUDIO_EXTS.includes(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(full);
          results.push({
            path: path.relative(dir, full).replace(/\\/g, '/'),
            name: entry.name,
            bytes: stat.size,
          });
          if (results.length >= limit) return;
        }
      }
    };
    walk(dir, 0);
    return results;
  }

  function checkAndConsumeBudget(convKey) {
    const cfg = getConfig()?.voice ?? {};
    const maxPerMin = Math.max(1, Number(cfg.maxPerMinute) || 3);
    const maxPerDay = Math.max(1, Number(cfg.maxPerDay) || 20);
    const now = Date.now();
    const recent = (minuteMap.get(convKey) ?? []).filter((ts) => now - ts < 60000);
    if (recent.length >= maxPerMin) {
      return { ok: false, code: 'VOICE_RATE_LIMITED', error: `每分钟最多发送 ${maxPerMin} 条语音` };
    }
    const dayStr = new Date(now).toISOString().slice(0, 10);
    const dayEntry = dayMap.get(convKey) ?? { day: dayStr, count: 0 };
    if (dayEntry.day !== dayStr) {
      dayEntry.day = dayStr;
      dayEntry.count = 0;
    }
    if (dayEntry.count >= maxPerDay) {
      return { ok: false, code: 'VOICE_DAILY_LIMIT', error: `每日最多发送 ${maxPerDay} 条语音` };
    }
    recent.push(now);
    minuteMap.set(convKey, recent);
    dayEntry.count += 1;
    dayMap.set(convKey, dayEntry);
    return { ok: true };
  }

  async function sendVoice(convKey, relPath, { onebot, outboundGuard }) {
    const cfg = getConfig()?.voice ?? {};
    if (cfg.enabled !== true) {
      return { ok: false, code: 'VOICE_DISABLED', error: '语音发送功能未开启' };
    }
    const gateCheck = outboundGuard.auditAndPrepare(convKey, '[语音]');
    if (!gateCheck.ok) return gateCheck;

    const dir = resolveVoiceDir();
    let absPath;
    try {
      absPath = safeJoinLibrary(dir, relPath);
    } catch (error) {
      return { ok: false, code: 'VOICE_PATH_BLOCKED', error: error.message };
    }
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { ok: false, code: 'VOICE_NOT_FOUND', error: `语音文件不存在：${relPath}` };
    }
    const maxBytes = Math.max(1024, Number(cfg.maxBytes) || 20971520);
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) {
      return { ok: false, code: 'VOICE_TOO_LARGE', error: `语音体积 ${stat.size}B 超过上限 ${maxBytes}B` };
    }
    const budget = checkAndConsumeBudget(convKey);
    if (!budget.ok) return budget;

    await onebot.sendRecord(convKey, absPath);
    return { ok: true, file: path.relative(dir, absPath).replace(/\\/g, '/'), bytes: stat.size };
  }

  return { listVoices, sendVoice };
}
