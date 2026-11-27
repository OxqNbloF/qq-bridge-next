// 模块子进程 IPC 辅助：读取 stdin 参数，并经 RELAY_ROOM_SOCK 调用主进程 /hub/exec
import http from 'node:http';

export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return { action: '', args: {} };
  const parsed = JSON.parse(raw);
  return {
    action: String(parsed?.action ?? '').trim(),
    args: parsed?.args && typeof parsed.args === 'object' ? parsed.args : {},
  };
}

export function writeStdoutJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function callHubExec({ capability, action, args = {}, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.RELAY_ROOM_SOCK;
    if (!socketPath) {
      reject(new Error('缺少 RELAY_ROOM_SOCK，无法连接主进程能力中心'));
      return;
    }
    const body = JSON.stringify({ capability, action, args });
    const req = http.request({
      socketPath,
      path: '/hub/exec',
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(text);
          if (res.statusCode >= 400 && parsed?.ok !== false) {
            resolve({ ok: false, status: res.statusCode, ...parsed });
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error(`主进程响应解析失败 (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`能力 ${capability}.${action} IPC 超时`)));
    req.end(body);
  });
}

export async function runCapability(handler) {
  try {
    const { action, args } = await readStdinJson();
    const res = await handler({ action, args });
    writeStdoutJson(res && typeof res === 'object' ? res : { ok: true, data: res });
  } catch (error) {
    writeStdoutJson({ ok: false, error: error?.message ?? String(error) });
    process.exitCode = 1;
  }
}
