// 模块脚本公共底座：从 stdin 读入参数，经 QQ_SESSION_SOCK 代理请求 Daemon，向 stdout 输出 JSON
import http from 'node:http';

export function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch (error) { reject(error); }
    });
    process.stdin.on('error', reject);
  });
}

export function writeStdoutJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function callDaemon({ module, method = 'GET', path, query, body, timeoutMs = 620_000 }) {
  const socketPath = process.env.QQ_SESSION_SOCK;
  if (!socketPath) {
    return Promise.resolve({ ok: false, error: '缺少 QQ_SESSION_SOCK，拒绝无会话上下文调用' });
  }
  const reqBody = JSON.stringify({ module, method, path, query, body });
  return new Promise((resolve) => {
    const req = http.request({
      socketPath,
      path: '/broker/agent-proxy',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(reqBody),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ ok: false, status: res.statusCode, error: text || `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', (error) => {
      resolve({ ok: false, error: `Unix Socket 通信失败：${error?.message ?? error}` });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('daemon call timeout'));
    });
    req.write(reqBody);
    req.end();
  });
}

export async function runHandler(handler) {
  try {
    const input = await readStdinJson();
    const res = await handler(String(input.action ?? ''), input.args ?? {});
    writeStdoutJson(res && typeof res === 'object' ? res : { ok: true, data: res });
  } catch (error) {
    writeStdoutJson({ ok: false, error: error?.message ?? String(error) });
    process.exitCode = 1;
  }
}

export const runModuleMain = runHandler;
