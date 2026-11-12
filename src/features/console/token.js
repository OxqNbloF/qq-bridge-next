// 控制台访问令牌：没配置时生成随机令牌并存到硬盘
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 创建令牌加载器：读配置或 state/console-token
export function createConsoleTokenLoader({ stateDir, atomicWriteText }) {
  return function loadOrCreateConsoleToken() {
    const tokenFile = path.join(stateDir, 'console-token');
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing) return existing;
    } catch {}
    const token = crypto.randomBytes(24).toString('hex');
    atomicWriteText(tokenFile, token);
    return token;
  };
}
