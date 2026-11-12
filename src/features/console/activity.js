// 读取活动日志尾部，供 /api/status 展示
import fs from 'node:fs';

// 创建读取日志末 n 行的函数
export function createActivityTailReader(file) {
  return function readActivityTail(n) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-n).join('\n');
    } catch {
      return '';
    }
  };
}
