// 人设卡库与按房间开场说明
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const SAFE_PERSONA_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,48}$/;

export function normalizePersonaName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || !SAFE_PERSONA_RE.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`人设名非法：${JSON.stringify(raw)}`);
  }
  return name;
}

export function createPersonaVault({ dataDir = '', getConfig = () => ({}) } = {}) {
  const cardsDir = dataDir ? path.join(dataDir, 'personas') : '';
  const metaFile = dataDir ? path.join(dataDir, 'personas.json') : '';
  const memCards = new Map();
  let state = { activePersona: '', intros: {} };
  const refreshCounter = new Map(); // roomId -> { name, countSinceFull }

  if (cardsDir) ensureDir(cardsDir);
  if (metaFile) {
    const saved = readJsonSafe(metaFile, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      state = {
        activePersona: String(saved.activePersona ?? ''),
        intros: saved.intros && typeof saved.intros === 'object' ? { ...saved.intros } : {},
      };
    }
  }

  function saveMeta() {
    if (metaFile) atomicWriteJson(metaFile, state, { mode: 0o600 });
  }

  function cardPath(name) {
    const clean = normalizePersonaName(name);
    const full = path.resolve(cardsDir, `${clean}.md`);
    if (!full.startsWith(path.resolve(cardsDir) + path.sep)) throw new Error('禁止路径穿越');
    return full;
  }

  function listPersonas() {
    const out = [];
    if (cardsDir && fs.existsSync(cardsDir)) {
      for (const entry of fs.readdirSync(cardsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3);
        const content = fs.readFileSync(path.join(cardsDir, entry.name), 'utf8');
        out.push({ name, chars: content.length, active: state.activePersona === name });
      }
      return out;
    }
    for (const [name, content] of memCards) {
      out.push({ name, chars: content.length, active: state.activePersona === name });
    }
    return out;
  }

  function getPersona(name) {
    const clean = normalizePersonaName(name);
    if (cardsDir) {
      const fp = cardPath(clean);
      if (!fs.existsSync(fp)) return null;
      return { name: clean, content: fs.readFileSync(fp, 'utf8'), active: state.activePersona === clean };
    }
    if (!memCards.has(clean)) return null;
    return { name: clean, content: memCards.get(clean), active: state.activePersona === clean };
  }

  function savePersona(name, content) {
    const clean = normalizePersonaName(name);
    const body = String(content ?? '').trim();
    if (!body) throw new Error('人设内容不能为空');
    if (cardsDir) atomicWriteText(cardPath(clean), `${body}\n`, { mode: 0o600 });
    else memCards.set(clean, body);
    return { name: clean, chars: body.length, active: state.activePersona === clean };
  }

  function deletePersona(name) {
    const clean = normalizePersonaName(name);
    let existed = false;
    if (cardsDir) {
      const fp = cardPath(clean);
      if (fs.existsSync(fp)) { fs.rmSync(fp, { force: true }); existed = true; }
    } else {
      existed = memCards.delete(clean);
    }
    if (state.activePersona === clean) {
      state.activePersona = '';
      saveMeta();
    }
    return existed;
  }

  function getActivePersona() {
    if (!state.activePersona) return { name: '', content: '' };
    const card = getPersona(state.activePersona);
    return card ? { name: card.name, content: card.content } : { name: '', content: '' };
  }

  function setActivePersona(name) {
    if (!name || !String(name).trim()) {
      state.activePersona = '';
      refreshCounter.clear();
      saveMeta();
      return { name: '', content: '' };
    }
    const card = getPersona(name);
    if (!card) throw new Error(`人设卡不存在：${name}`);
    state.activePersona = card.name;
    refreshCounter.clear();
    saveMeta();
    return { name: card.name, content: card.content };
  }

  function getRoomIntro(roomId) {
    const limit = Number(getConfig()?.character?.maxIntroChars) || 1000;
    return String(state.intros?.[roomId] ?? '').trim().slice(0, limit);
  }

  function setRoomIntro(roomId, text) {
    const limit = Number(getConfig()?.character?.maxIntroChars) || 1000;
    const clean = String(text ?? '').trim().slice(0, limit);
    if (!clean) delete state.intros[roomId];
    else state.intros[roomId] = clean;
    saveMeta();
    return clean;
  }

  function listRoomIntros() { return { ...state.intros }; }

  function resolvePromptCard(roomId, { forceFull = false } = {}) {
    const active = getActivePersona();
    const intro = getRoomIntro(roomId);
    if (!active.name || !active.content) {
      return { personaName: '', cardText: '', intro, full: false };
    }
    const maxChars = Number(getConfig()?.character?.maxCardChars) || 4000;
    const everyN = Math.max(0, Number(getConfig()?.character?.refreshEveryNWakes ?? 4));
    const tracker = refreshCounter.get(roomId);
    const shouldFull = forceFull
      || !tracker
      || tracker.name !== active.name
      || everyN <= 1
      || tracker.countSinceFull >= everyN;

    if (shouldFull) {
      refreshCounter.set(roomId, { name: active.name, countSinceFull: 1 });
      return { personaName: active.name, cardText: active.content.slice(0, maxChars), intro, full: true };
    }
    tracker.countSinceFull += 1;
    return { personaName: active.name, cardText: '', intro, full: false };
  }

  return {
    listPersonas, getPersona, savePersona, deletePersona,
    getActivePersona, setActivePersona, getRoomIntro, setRoomIntro, listRoomIntros, resolvePromptCard,
  };
}
