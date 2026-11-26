// 本地模块脚本共享底座：通过 QQ_SESSION_SOCK 调用 Daemon 能力，绝不泄露 Token 或直连控制台
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

export function callSocketAction({ module, action, args = {}, timeoutMs = 150000 }) {
  const socketPath = process.env.QQ_SESSION_SOCK;
  if (!socketPath) {
    return Promise.resolve({ ok: false, error: '缺少 QQ_SESSION_SOCK：拒绝无会话上下文调用' });
  }
  const reqBody = JSON.stringify({ module, action, args });
  return new Promise((resolve) => {
    const req = http.request({
      socketPath,
      path: '/broker/action',
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
        try { resolve(JSON.parse(text)); }
        catch { resolve({ ok: false, status: res.statusCode, error: text || `HTTP ${res.statusCode}` }); }
      });
    });
    req.on('error', (error) => {
      resolve({ ok: false, error: `Unix Socket 通信失败：${error?.message ?? error}` });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('socket action timeout')));
    req.write(reqBody);
    req.end();
  });
}

export async function runModule(handler) {
  try {
    const input = await readStdinJson();
    const res = await handler(String(input.action ?? ''), input.args ?? {});
    writeStdoutJson(res && typeof res === 'object' ? res : { ok: true, data: res });
  } catch (error) {
    writeStdoutJson({ ok: false, error: error?.message ?? String(error) });
    process.exitCode = 1;
  }
}
