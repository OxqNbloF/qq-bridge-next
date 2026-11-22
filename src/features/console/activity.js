// 读取活动日志尾部，供 /api/console/status 展示（只读尾部切片，避免大日志全量同步读盘）
import fs from 'node:fs';

const TAIL_WINDOW_BYTES = 64 * 1024;

// 创建读取日志末 n 行的函数
export function createActivityTailReader(file) {
  return function readActivityTail(n) {
    const want = Math.max(1, Number(n) || 50);
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const { size } = fs.fstatSync(fd);
      if (size <= 0) return '';
      const readBytes = Math.min(size, Math.max(TAIL_WINDOW_BYTES, want * 512));
      const start = Math.max(0, size - readBytes);
      const buf = Buffer.allocUnsafe(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, start);
      let raw = buf.toString('utf8', 0, bytesRead);
      // 若从文件中间截断读取，丢弃可能不完整的第一行
      if (start > 0) {
        const nl = raw.indexOf('\n');
        if (nl >= 0) raw = raw.slice(nl + 1);
      }
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-want).join('\n');
    } catch {
      return '';
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  };
}
