// 保证只跑一个副本：锁文件里写着进程元数据（向后兼容旧纯数字 PID）
import fs from 'node:fs';
import path from 'node:path';

export function parseLockContent(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const pid = Number(parsed?.pid);
      if (Number.isInteger(pid) && pid > 0) {
        return {
          pid,
          kind: parsed.kind === 'redact' ? 'redact' : 'bridge',
          root: typeof parsed.root === 'string' ? parsed.root : '',
          port: Number.isInteger(Number(parsed.port)) ? Number(parsed.port) : 0,
          startedAt: Number.isFinite(Number(parsed.startedAt)) ? Number(parsed.startedAt) : 0,
        };
      }
    } catch { return null; }
    return null;
  }
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? { pid, kind: 'bridge', root: '', port: 0, startedAt: 0 } : null;
}

const STARTUP_GRACE_MS = 30_000;

/**
 * 做一个只许跑一个的锁
 * @param {object} o
 * @param {string} o.lockFile
 * @param {string} o.configFile 读 consolePort 用
 * @param {Function} o.readJsonSafe 读 JSON 文件
 * @param {object} o.proc 进程信息与操作
 * @param {Function} o.execFileSync
 * @param {(msg:string)=>void} o.error
 */
export function createInstanceLock({ lockFile, configFile, readJsonSafe, proc, execFileSync, error: printError }) {
  const stateDir = path.dirname(lockFile);
  const rootDir = path.dirname(stateDir);

  function readConfiguredPort() {
    const cfg = readJsonSafe(configFile, {});
    return Number(cfg?.consolePort) || 3100;
  }

  /** PID 会被回收，用控制台端口占用判断桥接是否在跑 */
  function consolePortInUse() {
    try {
      const port = readConfiguredPort();
      const cmd = proc.platform === 'darwin'
        ? `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || netstat -anp tcp 2>/dev/null | grep LISTEN || true`
        : 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true';
      const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}(?:\\s|$)`).test(out);
    } catch {
      // 查不出来就当作已有人在跑，免得开两份
      return true;
    }
  }

  /** 核验存活 PID 是否就是本仓库 bridge.js（冷启动端口尚未监听时避免误删存活锁） */
  function isOwnBridgePid(pid) {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const cmd = String(out ?? '').trim();
      return cmd.includes('bridge.js') && (!rootDir || cmd.includes(rootDir));
    } catch {
      return false;
    }
  }

  // 拿锁；已经有一份在跑就退出
  function acquireLock() {
    fs.mkdirSync(stateDir, { recursive: true });
    const payload = JSON.stringify({
      pid: proc.pid,
      kind: 'bridge',
      root: rootDir,
      port: readConfiguredPort(),
      startedAt: Date.now(),
    });
    // 用 wx 一次写入锁元数据，防空文件被当成过期锁抢走
    const tryCreate = () => {
      try {
        fs.writeFileSync(lockFile, payload, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (tryCreate()) return;
    // 锁已存在：PID 不存活或内容为空视为过期，删后重试一次
    let stale = false;
    let observedContent = null;
    try {
      const content = fs.readFileSync(lockFile, 'utf8').trim();
      observedContent = content;
      const meta = parseLockContent(content);
      if (!meta) {
        stale = true;
      } else {
        const pid = meta.pid;
        try {
          proc.kill(pid, 0);
          // 隐私擦除脚本（kind === 'redact'）不监听端口，只要进程存活严禁抢锁
          if (meta.kind === 'redact') {
            printError(`[bridge] 检测到隐私删除任务正在运行（PID ${pid}，锁文件 ${lockFile}），请等待其完成后再启动。`);
            proc.exit(2);
          }
          // 处于冷启动宽限期或命令行已确认为本仓库 bridge.js 时，即使端口未监听也不判过期
          const mtimeMs = (() => { try { return fs.statSync(lockFile).mtimeMs; } catch { return 0; } })();
          const startedAt = meta.startedAt || mtimeMs;
          const inGrace = startedAt > 0 && (Date.now() - startedAt) < STARTUP_GRACE_MS;
          if (!inGrace && !isOwnBridgePid(pid) && !consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            if (meta.kind === 'redact' || consolePortInUse()) {
              printError(`[bridge] 控制台端口已被占用或隐私任务存活，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              proc.exit(2);
            }
            printError(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            printError(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${lockFile}）。若确认其已死，删除该文件后重试。`);
            proc.exit(2);
          }
        }
      }
    } catch (readError) {
      printError(`[bridge] 无法读取锁文件 ${lockFile}：${readError?.message ?? readError}`);
      proc.exit(1);
    }
    if (stale) {
      printError(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
      try {
        // 二次核对内容未被其他刚启动的进程替换，避免误删并发新锁
        if (fs.readFileSync(lockFile, 'utf8').trim() === observedContent) {
          const staleCopy = `${lockFile}.stale.${proc.pid}.${Date.now()}`;
          try {
            fs.renameSync(lockFile, staleCopy);
            try { fs.unlinkSync(staleCopy); } catch {}
          } catch {
            try { fs.unlinkSync(lockFile); } catch {}
          }
        }
      } catch {}
      if (tryCreate()) return;
    }
    printError(`[bridge] 已有实例在运行（锁文件 ${lockFile}）。若确认其已死，删除该文件后重试。`);
    proc.exit(2);
  }

  // 释放锁
  function releaseLock() {
    try {
      if (fs.existsSync(lockFile)) {
        const meta = parseLockContent(fs.readFileSync(lockFile, 'utf8'));
        if (meta?.pid === proc.pid) fs.unlinkSync(lockFile);
      }
    } catch {}
  }

  return { acquireLock, releaseLock, consolePortInUse };
}
