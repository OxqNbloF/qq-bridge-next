// 记忆压缩记到哪：每个聊天已压缩到的 archive seq
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';

// 创建记录压缩进度的读写工具
export function createCompressCursor({ file }) {
  let cursors = null;
  // 第一次用到时才读进度文件
  const load = () => {
    if (!cursors) {
      const raw = readJsonSafe(file, null);
      // 文件版本比本程序新则拒绝读写，防旧格式覆盖
      if (raw && Number(raw.version) > 1) throw new Error(`压缩游标文件版本 ${raw.version} 比本程序新，拒绝读写`);
      cursors = raw && typeof raw.cursors === 'object' && raw.cursors ? { ...raw.cursors } : {};
    }
    return cursors;
  };
  return {
    // 取会话记到哪的位置，无效值返回 0
    get(convId) {
      const value = Number(load()[convId]);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    },
    /** 只往前走不后退；存到硬盘失败就报错 */
    set(convId, seq) {
      const next = Number(seq);
      if (!Number.isSafeInteger(next) || next <= this.get(convId)) return;
      const updated = { ...load(), [convId]: next };
      atomicWriteJson(file, { version: 1, cursors: updated });
      cursors = updated;
    },
  };
}
