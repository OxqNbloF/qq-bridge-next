// 零 Shell 本地脚本执行器：execFile/spawn(shell:false) + 最小环境 + 可选 Linux Bubblewrap 沙箱
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 构造 Linux Bubblewrap (bwrap) 沙箱参数 */
export function buildBwrapArgs({ bin, binArgs, modDir, repoRoot, socketPath, allowNetwork = false }) {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--ro-bind', modDir, modDir,
  ];
  if (repoRoot && repoRoot !== modDir) {
    args.push('--ro-bind', repoRoot, repoRoot);
  }
  if (socketPath) {
    const sockDir = path.dirname(socketPath);
    args.push('--bind', sockDir, sockDir);
  }
  if (!allowNetwork) {
    args.push('--unshare-net');
  }
  args.push('--die-with-parent', '--', bin, ...binArgs);
  return args;
}

/** 以零 Shell 方式执行单个模块脚本（JSON stdin/stdout） */
export async function runModuleScript({
  entry,
  action,
  args = {},
  socketPath = '',
  scope = 'chat',
  repoRoot = process.cwd(),
  timeoutMs,
  useBwrap = false,
  spawnFn = spawn,
}) {
  const runtimeBin = entry.manifest.runtime === 'python3' ? 'python3' : process.execPath;
  const baseArgs = [entry.entryPath];
  const effectiveTimeout = Math.min(120_000, Math.max(1000, Number(timeoutMs ?? entry.manifest.timeoutMs) || 20_000));

  const useSandbox = Boolean(useBwrap && process.platform === 'linux');
  const cmd = useSandbox ? 'bwrap' : runtimeBin;
  const cmdArgs = useSandbox
    ? buildBwrapArgs({
      bin: runtimeBin,
      binArgs: baseArgs,
      modDir: entry.modDir,
      repoRoot,
      socketPath,
      allowNetwork: entry.manifest.network === true,
    })
    : baseArgs;

  const minimalEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    QQ_SESSION_SOCK: String(socketPath || ''),
    QQ_MODULE_SCOPE: String(scope || 'chat'),
    QQ_BRIDGE_ROOT: String(repoRoot),
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, cmdArgs, {
        shell: false,
        cwd: entry.modDir,
        env: minimalEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: `启动模块 ${entry.manifest.name} 失败：${error?.message ?? error}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref?.();
      finish({ ok: false, error: `模块 ${entry.manifest.name}.${action} 执行超时（${effectiveTimeout}ms）` });
    }, effectiveTimeout);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 16384) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ok: false, error: `模块 ${entry.manifest.name} 运行异常：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            finish(parsed);
            return;
          }
        } catch {}
      }
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim() || `模块 ${entry.manifest.name}.${action} 退出码 ${code}` });
        return;
      }
      finish({ ok: false, error: `模块 ${entry.manifest.name}.${action} 未返回合法 JSON` });
    });

    try {
      child.stdin?.end(JSON.stringify({ action, args }));
    } catch {}
  });
}
