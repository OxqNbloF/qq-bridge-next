// 保证只跑一个副本：锁文件里写着进程号
import fs from 'node:fs';
import path from 'node:path';

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

  /** PID 会被回收，用控制台端口占用判断桥接是否在跑 */
  function consolePortInUse() {
    try {
      const cfg = readJsonSafe(configFile, {});
      const port = Number(cfg?.consolePort) || 3100;
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

  // 拿锁；已经有一份在跑就退出
  function acquireLock() {
    fs.mkdirSync(stateDir, { recursive: true });
    // 用 wx 一次写入 PID，防空文件被当成过期锁抢走
    const tryCreate = () => {
      try {
        fs.writeFileSync(lockFile, String(proc.pid), { flag: 'wx', mode: 0o600 });
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
      if (!content) {
        stale = true;
      } else {
        const pid = Number(content);
        if (!Number.isInteger(pid) || pid <= 0) {
          stale = true;
        } else {
          try {
            proc.kill(pid, 0);
            // PID 存活不代表是桥接，再查端口
            if (!consolePortInUse()) stale = true;
          } catch (error) {
            if (error.code === 'ESRCH') {
              stale = true;
            } else if (error.code === 'EPERM') {
              // EPERM 不能证明桥接在跑，端口空闲才按过期处理
              if (consolePortInUse()) {
                printError(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
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
      if (fs.existsSync(lockFile) && Number(fs.readFileSync(lockFile, 'utf8').trim()) === proc.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  }

  return { acquireLock, releaseLock, consolePortInUse };
}
