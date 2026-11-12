// AI 反馈与工具调用日志，存到硬盘前先打码
import fs from 'node:fs';
import { createCappedLogger } from '../infra/log.js';
import { truncateText } from '../md-to-plain.js';
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';

// 创建反馈与工具日志存储
export function createFeedbackStore(b) {
  // 读取全部反馈记录
  function readFeedbackEntries() {
    const data = readJsonSafe(b.FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  // 追加一条反馈记录
  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: b.redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(b.FEEDBACK_FILE, list);
  }

  // 读取最近 limit 条工具调用日志
  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(b.TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(b.TOOL_LOG_FILE, 2000);

  // 追加一条工具调用日志
  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = b.redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = b.redactSensitiveText(safeEntry.args);
        }
      }
      // 内存计数行数上限，避免每次追加都重读文件
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      b.log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  // 递归脱敏对象中的敏感值
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，防原型链污染
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return b.redactSensitiveText(obj);
    return obj;
  }

  // 读出工具调用参数并打码
  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // 一层层读出 JSON 字符串参数再打码，防令牌存到硬盘
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  return { readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog, redactSensitive, sanitizeToolArgs };
}
