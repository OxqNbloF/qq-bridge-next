// QQ 会话与 DSH 会话映射的读写
import fs from 'node:fs';
import { atomicWriteJson } from '../store/fs-atomic.js';
import { migrateDocument, stampSchema } from '../store/schema.js';

// 建一个存“QQ 聊天和 DSH 会话对应关系”的地方，b 是桥接递进来的东西
export function createSessionStore(b) {
  // 读坏时必须报错且只读不写，
  // 否则空映射会回写覆盖原文件
  let stateWritable = true;
  // 从 sessions.json 读取映射
  function loadState() {
    let raw;
    try {
      raw = fs.readFileSync(b.STATE_FILE, 'utf8');
    } catch (error) {
      b.state = { sessions: {}, sessionPolicies: {} };
      if (error?.code !== 'ENOENT') {
        stateWritable = false;
        b.log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let loaded = null;
    if (raw.trim() !== '') {
      try {
        const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        loaded = JSON.parse(text);
      } catch (error) {
        b.state = { sessions: {}, sessionPolicies: {} };
        stateWritable = false;
        b.log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
        return;
      }
    }
    if (loaded && loaded.sessions && typeof loaded.sessions === 'object') {
      // 无版本按 v0；版本更高则只读不写
      try {
        loaded = migrateDocument('sessions', loaded).doc;
      } catch (error) {
        stateWritable = false;
        b.log(`⚠️ sessions.json：${error?.message ?? error}；已降级为「只读不写」`);
      }
      b.state = loaded;
    } else b.state = { sessions: {} };
    if (!b.state.sessionPolicies || typeof b.state.sessionPolicies !== 'object' || Array.isArray(b.state.sessionPolicies)) b.state.sessionPolicies = {};
  }
  // 一次写完地存回 sessions.json
  function saveState() {
    // 一次写完，避免 .tmp 被占用和权限不一致
    if (!stateWritable) return; // 读坏时不回写，防止永久丢失
    atomicWriteJson(b.STATE_FILE, stampSchema('sessions', b.state));
  }

  return { loadState, saveState };
}
