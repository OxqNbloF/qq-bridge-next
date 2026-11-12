// 几个诊断探针共用的登录和请求代码
//
// 为什么要有它
// 以前每个探针各抄一份找令牌的代码
// 新版 DSH 改了做法，老办法彻底失效了
// 启动令牌只存在内存里，查不到也推不出来
// 日志里剩下的是上一次的旧令牌，换来的凭证会失效
// 正式代码早改好了，这些探针没跟上
// 探针一直连不上，还没人发现
//
// 现在统一用本机保存的签名密钥直接签一个登录凭证
// 做法和 src/dsh-client.js 里一样
//
// 探针的工作目录一律放在系统临时文件夹
// 仓库里 state/ 的权限被收紧过，沙箱里建不了目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

export const PROBE_BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

// 拿一个能用的登录凭证，三种办法依次试
export function probeCookie({ base = PROBE_BASE } = {}) {
  const explicit = process.env.DSH_PROBE_COOKIE;
  if (explicit) return explicit;
  const minted = discoverDshSessionCookie(base);
  if (minted) return minted;
  throw new Error(
    `无法为 ${base} 取得会话 Cookie：读不到 ${path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')} `
    + '里的 client-connection/browser-session 签名密钥（DSH 是否正在运行？DSH_HOME 是否指向真正的 .dsh？）。'
    + '也可以设 DSH_PROBE_COOKIE 直接给一个 Cookie。'
  );
}

// 造一个调用 DSH 接口的小函数
export function probeRpc(cookie, { base = PROBE_BASE } = {}) {
  return async function rpc(endpoint, args) {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe-' + Math.random().toString(36).slice(2, 8),
        method: endpoint,
        payload: { args },
      }),
    });
    const body = await response.json();
    return body.result;
  };
}

// 连上 DSH 的事件推送通道
export function probeMuxSocket(cookie, { base = PROBE_BASE } = {}) {
  const url = new URL('/api/remote.mux', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url, { headers: { cookie } });
}

// 在系统临时文件夹里给探针建一个工作目录
export function probeWorkspaceDir(name) {
  const dir = path.join(os.tmpdir(), `qq-bridge-probe-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
