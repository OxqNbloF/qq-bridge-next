// 带行数上限的同步追加日志与本地时钟
import fs from 'node:fs';
import path from 'node:path';

/** 单条日志最大长度 */
export const LOG_LINE_MAX = 1000;

/** 行数上限追加写：内存计数，到上限 rename 轮转 */
export function createCappedLogger(file, maxLines) {
  const dir = path.dirname(file);
  let lines = -1; // -1 表示还没数过
  return function append(text) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败就截断，防止无限增长
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS */
export function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  // 补零到两位
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 桥接主日志：同时打印到屏幕和写进文件。
 * @param {object} opts 文件路径、行数上限、去敏函数等
 */
export function createBridgeLog({ file, maxLines = 2000, redact, console: out = console }) {
  const appendBridgeLog = createCappedLogger(file, maxLines);
  return function log(...args) {
    let line;
    try {
      const body = args
        .map((a) => redact(typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .replace(/[\r\n]+/g, ' ');
      line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
    } catch {
      line = `${localClock()} [bridge] (日志参数无法序列化)`;
    }
    // console.log 单独 try：EPIPE 不能变成未捕获异常
    try { out.log(line); } catch {}
    appendBridgeLog(`${line}\n`);
  };
}

/**
 * QQ 活动日志：每次收发都追加一行。
 * @param {object} opts 文件路径、行数上限、去敏函数
 */
export function createActivityLog({ file, maxLines = 500, redact }) {
  const appendActivityLog = createCappedLogger(file, maxLines);
  return function appendActivity(line) {
    // 用本地时间而非 UTC
    appendActivityLog(`[${localClock()}] ${redact(String(line).replace(/[\r\n]+/g, ' '))}\n`);
  };
}
