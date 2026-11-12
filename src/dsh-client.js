// 连接 DSH 的程序接口：发请求、收事件、做登录验证
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import YAML from 'js-yaml';
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';

/** DSH home：凭据文件与（历史）启动日志都在这里。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从环境变量或日志里找 DSH 的启动令牌 */
export function discoverDshLaunchToken() {
  const fromEnv = process.env.DSH_LAUNCH_TOKEN;
  if (typeof fromEnv === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(fromEnv)) return fromEnv;
  const home = resolveDshHome();
  // 先看 logs，再兼容旧版的 guard/logs
  const dirs = [path.join(home, 'logs'), path.join(home, 'guard', 'logs')];
  for (const logsDir of dirs) {
    let files;
    try {
      files = fs.readdirSync(logsDir)
        .filter((name) => /^server-.*\.(?:out\.)?log$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(path.join(logsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
    }
    for (const { name } of files) {
      try {
        const text = fs.readFileSync(path.join(logsDir, name), 'utf8');
        const match = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
        if (match) return match[1];
      } catch {
        // 单个日志文件可能正被 DSH 占用/轮转，跳过继续看更早的日志。
      }
    }
  }
  return '';
}

// 用本机存的钥匙自己签登录凭证，不用启动令牌
const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
/** 自己签发的登录凭证有效期：一小时，够用又留余量 */
export const MINTED_COOKIE_LIFETIME_MS = 60 * 60 * 1000;
/** 到期前 5 分钟就换新的，免得到时被拒 */
const MINTED_COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// 把二进制转成网址里能用的文本
const base64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * 读取 DSH 存在硬盘上的登录签名钥匙。
 * @returns 32 字节密钥；文件缺失/被占用/结构不符时返回 null（调用方回退）。
 */
export function readBrowserSessionSecret() {
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const record = doc?.records?.[BROWSER_SESSION_KEY];
    if (record?.kind !== 'grant' || record?.payload?.version !== 1) return null;
    const secret = record.payload.secret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
    const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    // 长度必须正好 32 字节；否则说明 DSH 换了密钥方案，宁可回退也不发坏 Cookie。
    return decoded.byteLength === SECRET_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * 给指定 DSH 地址签一个登录 Cookie。
 * @param baseUrl - DSH 地址，也就是要登录的那个
 * @param secret - 本机存放的签名密钥
 * @param options.lifetimeMs - 有效期。
 * @returns 可直接放进 Cookie 头的串。
 */
export function mintBrowserSessionCookie(baseUrl, secret, { lifetimeMs = MINTED_COOKIE_LIFETIME_MS } = {}) {
  const authority = new URL(String(baseUrl)).host;
  if (!authority) throw new Error('DSH baseUrl has no authority');
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = base64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${signature}`;
}

/**
 * 一步到位：为本机 DSH 铸造会话 Cookie。
 * @returns Cookie 串；密钥不可用时返回 ''（调用方回退到启动 token 交换）。
 */
export function discoverDshSessionCookie(baseUrl, options) {
  // 自动发现只能使用本机凭据；远程部署必须走显式配置的 launch token。
  if (!isLoopbackBase(baseUrl)) return '';
  const secret = readBrowserSessionSecret();
  if (!secret) return '';
  try {
    return mintBrowserSessionCookie(baseUrl, secret, options);
  } catch {
    return '';
  }
}

/** DSH 地址是不是本机地址；是才敢把令牌发过去 */
export function isLoopbackBase(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '[::1]') return true;
    // 127.0.0.0/8 整个网段都是回环
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** 新协议 RPC 的 args 包装：旧 payload -> { <参数名>: payload }。 */
const METHOD_ARG_WRAPPERS = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/rename': 'request',
  'session/fork': 'request',
  'session/updateQueue': 'request',
  'session/page': 'request',
  'session/search': 'request',
  'session/follow': 'request',
  'session/projections': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/delete': 'request',
  'workspace/archiveSession': 'request',
  'workspace/insertBefore': 'request',
  'workspace/insertSessionBefore': 'request',
  'agentPresets/list': null,
  'settings/describe': null,
};

/** 点号方法名 -> 斜杠 endpoint。 */
function endpointOf(method) {
  return method.replace(/\./g, '/');
}

/** 打开会话时一次带回多少条历史消息 */
export const FOLLOW_SNAPSHOT_MESSAGES = 200;

/** 从会话的待处理队列里取出还没处理的消息 */
export function inboxItemsOfProjections(values) {
  if (values === null || typeof values !== 'object') return [];
  const inbox = values.inbox;
  // 没开助手或没登记收件箱时，就是没有待处理消息
  if (inbox === undefined) return [];
  if (inbox === null || typeof inbox !== 'object' || Array.isArray(inbox)) {
    throw new Error('invalid session inbox projection');
  }
  const items = [];
  for (const boundary of ['next-turn', 'next-step']) {
    const list = inbox[boundary];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error('invalid session inbox projection');
    items.push(...list);
  }
  return items;
}

/** 取出每条待处理消息的编号，缺一个就报错 */
export function inboxItemIds(items) {
  return items.map((item) => {
    const id = item?.id;
    if (typeof id !== 'string' || !id) throw new Error('invalid session inbox item');
    return id;
  });
}

/** 从控制流的开场数据里取这个会话的待处理消息 */
export function controlBaselineInboxItems(frame, sessionId) {
  const projections = frame?.value?.projections;
  if (projections === null || typeof projections !== 'object' || Array.isArray(projections)) {
    throw new Error('invalid session/control baseline');
  }
  if (!Object.hasOwn(projections, sessionId)) return [];
  return inboxItemsOfProjections(projections[sessionId]?.values);
}

/** 把旧 payload 包装成新协议要求的 { args }，并补新版必填字段。 */
function wrapArgs(method, payload) {
  const endpoint = endpointOf(method);
  let body = payload ?? {};
  // 新版 SessionPromptRequest 强制要求 requestId。
  if (endpoint === 'session/prompt' && typeof body.requestId !== 'string') {
    body = { ...body, requestId: randomUUID() };
  }
  const wrapper = METHOD_ARG_WRAPPERS[endpoint];
  if (wrapper === null) return { args: {} };
  if (wrapper === undefined) return { args: body };
  return { args: { [wrapper]: body } };
}

// 鉴权交换供多个 RPC 共用；取消一个调用只停止它自己的等待，不中断其他调用。
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // 收到取消信号就报错
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

export class NodeApiClient extends AbstractApiClient {
  constructor(baseUrl, timeoutMs, auth) {
    super(timeoutMs);
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.auth = auth ?? {};
    this.launchToken = this.auth.token || '';
    this.cookie = null;
    this.cookiePromise = null;
    this._authEpoch = 0;
    this._muxSendOpen = null;
    // 只缓存成功读取的签名密钥；首次启动或原子替换期间的读取失败必须能重试。
    this._secret = undefined;
    // token 是用户显式配置的（true）还是从日志猜的（false）。猜来的不优先于离线铸造。
    this.tokenExplicit = this.auth.tokenExplicit === true;
    // 上次用的登录方式，以及要不要改用启动令牌。
    // 只有自己签的凭证真被拒才换令牌：断线重连是常态，不能拿它当证据，
    // 否则会一直抱着过期的令牌不放。
    this._strategy = null;
    this._preferToken = false;
    // 铸造 Cookie 的到期时刻；到期前主动重铸，避免先撞一次 401 再重试。
    this._cookieExpiresAt = 0;
    // 要一直订阅的会话：重连后要重新订阅，否则收不到回复
    this._desiredFollows = new Set();
  }

  /** Node 没有页面地址，直接用配置的 DSH 地址 */
  resolveBase() {
    return this.baseUrl;
  }

  /**
   * 换一个 DSH 地址；地址变了就要重新登录。
   * @param baseUrl - 新的 DSH 地址。
   * @returns 是否真的换了地址。
   */
  rebind(baseUrl) {
    const next = String(baseUrl ?? '').replace(/\/+$/, '');
    if (!next || next === this.baseUrl) return false;
    this.baseUrl = next;
    this.invalidateAuth();
    return true;
  }

  /** 让当前登录凭证失效，下次自动重新获取 */
  invalidateAuth() {
    this._authEpoch += 1;
    this.cookie = null;
    this.cookiePromise = null;
    this._cookieExpiresAt = 0;
    // 密钥文件可能刚被 DSH 重建（首次启动写入凭据），重探一次。
    this._secret = undefined;
    // 这里不改登录方式的偏好：断线是常态，只有真被拒才换
    this._strategy = null;
    const discovered = discoverDshLaunchToken();
    if (discovered) this.launchToken = discovered;
  }

  /** 取本机存着的签名钥匙，取到就记住。 */
  browserSessionSecret() {
    if (this._secret === undefined || this._secret === null) {
      const secret = readBrowserSessionSecret();
      if (secret !== null) this._secret = secret;
      return secret;
    }
    return this._secret;
  }

  /** 有没有至少一种登录办法 */
  hasAuth() {
    return Boolean(this.launchToken) || this.browserSessionSecret() !== null;
  }

  /**
   * 换一个能用的登录 Cookie：有启动令牌就用令牌换，没有就自己签。
   * @param signal - 取消信号。
   * @returns 可直接放进 Cookie 头的串。
   */
  /** 铸造并缓存一个会话 Cookie，同时记下到期时刻。 */
  _mintCookie(secret) {
    this.cookie = mintBrowserSessionCookie(this.baseUrl, secret);
    this._cookieExpiresAt = Date.now() + MINTED_COOKIE_LIFETIME_MS;
    this._strategy = 'minted';
    return this.cookie;
  }

  async ensureAuth(signal) {
    signal?.throwIfAborted();
    // 铸造来的 Cookie 到期前主动重铸：铸造是纯本地 HMAC、没有网络往返，
    // 比「用到 401 再重试」便宜，也不会在重试窗口里丢掉一次 RPC。
    if (this.cookie && this._strategy !== 'minted') return this.cookie;
    if (this.cookie && Date.now() < this._cookieExpiresAt - MINTED_COOKIE_REFRESH_MARGIN_MS) return this.cookie;
    this.cookie = null;
    const secret = this.browserSessionSecret();
    // 铸造只对回环地址成立：签名密钥取自本机 DSH_HOME，远程 DSH 用的是另一份密钥，
    // 拿本机密钥去签只会换来 401。
    const canMint = secret !== null && isLoopbackBase(this.baseUrl);
    // 默认先用自己签的凭证：不靠启动日志，DSH 重启也不失效。两个例外：
    // 用户在 config.json 里显式填了 dsh.authToken（那是明确意图，尊重它），
    // 或铸造刚被 401（_preferToken，见 _doFetchWithAuth）。
    if (canMint && !this._preferToken && !this.tokenExplicit) return this._mintCookie(secret);
    if (!this.launchToken) {
      if (canMint) return this._mintCookie(secret);
      throw new Error(
        'DSH 鉴权不可用：没有可用的 launch token（config.json 的 dsh.authToken 为空，日志里也没发现），'
        + `也读不到 ${path.join(resolveDshHome(), '.credentials.yaml')} 里的 `
        + `${BROWSER_SESSION_KEY} 签名密钥。请在 config.json 里显式设置 dsh.authToken，`
        + '或确认 DSH_HOME 指向真正的 .dsh 目录。'
      );
    }
    // 启动令牌只能放在网址里，绝不能发给别的电脑
    if (!this.auth.allowRemote && !isLoopbackBase(this.baseUrl)) {
      throw new Error(`拒绝把 DSH launch token 发往非本机地址（${this.baseUrl}）：那是进程启动凭据，只应交给 127.0.0.1。确实要连远程 DSH 时请在 config.json 里显式设置 dsh.allowRemote: true`);
    }
    if (this.cookiePromise) return waitWithSignal(this.cookiePromise, signal);
    // 换登录凭证的请求
    const promise = (async () => {
      const epoch = this._authEpoch;
      const url = new URL(this.baseUrl);
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      url.searchParams.set('token', this.launchToken);
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      const setCookie = res.headers.get('set-cookie');
      await res.body?.cancel();
      if (!setCookie) throw new Error(`DSH token exchange failed: HTTP ${res.status}`);
      if (epoch !== this._authEpoch) throw new Error('DSH auth session invalidated during token exchange');
      this.cookie = setCookie.split(';')[0];
      this._strategy = 'token';
      return this.cookie;
    })();
    this.cookiePromise = promise;
    // 请求结束后清掉缓存
    const clearPromise = () => {
      if (this.cookiePromise === promise) this.cookiePromise = null;
    };
    // 收尾时清掉缓存；不能再抛出没人接的错误
    promise.then(clearPromise, clearPromise);
    return waitWithSignal(promise, signal);
  }

  async doFetch(input, init) {
    return this._doFetchWithAuth(input, init, false);
  }

  /** 停掉一个会话：先清排队的消息，再取消正在跑的回合 */
  async stopSessionWork(sessionId, { signal, timeoutMs = 8000 } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const deadline = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let removed = 0;
    let failure;
    try {
      // 为取消当前 turn 留出时间，即使 control 流没有及时返回 baseline。
      const queueSignal = AbortSignal.any([sig, AbortSignal.timeout(Math.min(5000, timeoutMs))]);
      // 上面的读取已经检查过消息编号，取不到会直接报错
      const itemIds = await this._readSessionQueue(sessionId, queueSignal);
      for (const itemId of new Set(itemIds)) {
        const response = await this.callUnary('session/updateQueue', {
          sessionId, itemId, action: { kind: 'remove' }
        }, sig);
        if (response.result?.ok) removed += 1;
        else if (response.result?.error?.code !== 'session/queue-item-not-found') unwrap(response, 'session/updateQueue');
        // 已被 agent 取走的队列项不再存在；接下来的 cancel 会取消当前 turn。
      }
    } catch (error) {
      failure = error;
    }
    try {
      const response = await this.callUnary('session/cancel', { sessionId }, sig);
      if (!response.result?.ok && response.result?.error?.code !== 'session/not-found') unwrap(response, 'session/cancel');
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    return { removed };
  }

  /**
   * 读出一个会话还没处理的消息，用来在停掉前清空。
   * 先走普通请求，不行再退回控制流。
   */
  async _readSessionQueue(sessionId, signal) {
    await this.ensureAuth(signal);
    signal?.throwIfAborted();
    try {
      const response = await this.callUnary('session/projections', { sessionId }, signal);
      if (response.result?.ok) {
        // 读出来是空，就说明会话不在运行列表里，没有待处理消息
        return inboxItemIds(inboxItemsOfProjections(response.result.value?.values));
      }
      // `session/not-found` 同样意味着没有队列可清；其余错误交给回退路径判定。
      if (response.result?.error?.code === 'session/not-found') return [];
      // endpoint 不存在之类的协议级错误 ⇒ 走 control 流回退。
    } catch (error) {
      signal?.throwIfAborted();
      // 一元 RPC 失败（旧 DSH 不认这个 endpoint / 网关拒绝）时回退，不把异常当结论。
      void error;
    }
    return this._readSessionQueueViaControl(sessionId, signal);
  }

  /** 回退路径：全宿主 `session/control` 流的开场 baseline。 */
  async _readSessionQueueViaControl(sessionId, signal) {
    signal?.throwIfAborted();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      // 结束这次等待，只结算一次
      const finish = (error, items) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        socket.removeEventListener('open', open);
        socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
        if (error) reject(error); else resolve(items);
      };
      // 被取消时直接结束
      const abort = () => finish(signal.reason);
      // 连接出错或断开就报错
      const failed = () => finish(new Error('session/control connection closed before baseline'));
      // 连上后告诉服务器要打开什么
      const open = () => {
        try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } })); }
        catch (error) { finish(error); }
      };
      // 收到数据后看看是不是要找的
      const message = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error' || frame.type === 'end') {
            finish(new Error(`session/control ended before baseline${frame.error?.code ? ` (${frame.error.code})` : ''}`));
          } else if (frame.type === 'item' && frame.value?.type === 'baseline') {
            finish(null, inboxItemIds(controlBaselineInboxItems(frame.value, sessionId)));
          }
        } catch (error) { finish(error); }
      };
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async _doFetchWithAuth(input, init, isRetry) {
    const authEpoch = this._authEpoch;
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (this.hasAuth()) {
      try {
        const cookie = await this.ensureAuth(init?.signal);
        headers.set('cookie', cookie);
      } catch (error) {
        if (!isRetry && this.launchToken && /token exchange failed|invalidated during token exchange/i.test(error?.message ?? '')) {
          // 交换失败通常意味着那个 launch token 已经过期（DSH 重启过，日志里的是上一个
          // 进程的）。解除「改用 token」的偏好，否则客户端会一直抱着一个死 token 不放 ——
          // 这正是「一次 401 之后所有 RPC 永久失败」的成因。
          this._preferToken = false;
          if (authEpoch === this._authEpoch) this.invalidateAuth();
          return this._doFetchWithAuth(input, init, true);
        }
        throw error;
      }
    }
    init?.signal?.throwIfAborted();
    // RPC 主体包含聊天内容，不能随服务端重定向转交给另一端点。
    const response = await fetch(input, { ...init, headers, redirect: 'error' });
    if (!isRetry && response.status === 401 && this.hasAuth()) {
      await response.body?.cancel();
      // 只有真被拒才换登录方式：自己签的被拒就改用启动令牌
      if (this._strategy === 'minted' && this.launchToken) this._preferToken = true;
      else if (this._strategy === 'token') this._preferToken = false;
      // 多个请求同时被拒时只换一次凭证，别把新换的也作废
      if (authEpoch === this._authEpoch) this.invalidateAuth();
      return this._doFetchWithAuth(input, init, true);
    }
    return response;
  }

  /** 发一个普通请求：按新协议拼地址和参数 */
  async callUnary(method, payload, signal, timeoutPolicy = 'default') {
    const endpoint = endpointOf(method);
    const message = {
      type: 'client-request',
      rpcId: this.mintRpcId(),
      method: endpoint,
      payload: wrapArgs(method, payload)
    };
    this.onEnvelope(message);
    const response = await this.postJson(`/api/${endpoint}`, message, signal, timeoutPolicy);
    const full = await response.json();
    if (!full || full.type !== 'server-response' || full.rpcId !== message.rpcId || !full.result) {
      throw new Error(`invalid server-response for ${endpoint}`);
    }
    this.onEnvelope(full);
    return { rpcId: full.rpcId, result: full.result };
  }

  /** 回答 DSH 的提问或审批 */
  async respond(message, signal) {
    if (message?.clientId && message?.eventId && message?.outcome) {
      const response = await this.callUnary('$events/result', {
        clientId: message.clientId,
        eventId: message.eventId,
        outcome: message.outcome
      }, signal);
      if (!response.result?.ok) {
        const { code, message: errMsg } = response.result?.error ?? {};
        throw new Error(`$events/result rejected${code ? ` (${code})` : ''}: ${errMsg ?? 'unknown error'}`);
      }
      return response;
    }
    this.onEnvelope(message);
    const response = await this.postJson('/api/respond', message, signal);
    return response.json();
  }

  /** 取可用的助手预设列表 */
  agentPresets = {
    list: (payload, signal) => this.callUnary('agentPresets.list', payload, signal),
  };

  /** 事件流：连上后自动订阅所有会话 */
  events = {
    mux: (_payload, signal, onOpen) => this.openRemoteEventStream(signal, onOpen),
    host: (_payload, signal, onOpen) => this.openRemoteEventStream(signal, onOpen),
    follow: (sessionId) => this._followSession(sessionId),
    /** 不再订阅某个会话，免得越积越多 */
    forget: (sessionId) => {
      if (!sessionId) return;
      this._desiredFollows.delete(String(sessionId));
    },
  };

  openRemoteEventStream(signal, onOpen) {
    const gen = this._remoteMuxGenerator(signal, onOpen);
    return {
      [Symbol.asyncIterator]: () => gen,
      follow: (sessionId) => this._followSession(sessionId),
      forget: (sessionId) => { if (sessionId) this._desiredFollows.delete(String(sessionId)); }
    };
  }

  _followSession(sessionId) {
    if (!sessionId) return;
    const sid = String(sessionId);
    // 先记账再发送：即使此刻没有连接（或正处在重连窗口内），重连时也会重放。
    this._desiredFollows.add(sid);
    if (this._muxSendOpen) this._muxSendOpen(sid);
  }

  async *_remoteMuxGenerator(signal, onOpen) {
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own.signal;
    sig.throwIfAborted();
    await this.ensureAuth(sig);
    sig.throwIfAborted();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    const inbox = [];
    let wake;
    let socketOpen = false;
    let eventStreamId = null;
    let eventClientId = null;
    let ended = false;
    const followed = new Set();
    const streamToSession = new Map();
    const sessionToStream = new Map();
    // 把一条数据放进待发队列
    const enqueue = (item) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    // 结束这条事件流
    const endStream = () => {
      if (ended) return;
      ended = true;
      if (this._muxSendOpen === sendOpen) this._muxSendOpen = null;
      // 连接断了就丢掉旧凭证，重连时重新登录
      if (!sig.aborted) this.invalidateAuth();
      enqueue({ kind: 'end' });
    };
    // 订阅一个会话的消息
    const sendOpen = (sessionId) => {
      if (ended || !socketOpen || sessionToStream.has(sessionId) || followed.has(sessionId)) return;
      const streamId = randomUUID();
      streamToSession.set(streamId, sessionId);
      sessionToStream.set(sessionId, streamId);
      followed.add(sessionId);
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                // DSH 0.2.1-rc.3 起，session.follow **不再**默认激活冷会话：
                // 省略 activate 只读历史、不 promote Agent。桥接启动时会重放
                // state.sessions 里全部会话的 follow；DSH 重启后它们都是冷会话，
                // 若还有 pending inbox（例如断线前排队的两条消息），不激活就会
                // 一直停在那里，QQ 上表现为「它不理我了」。显式激活恢复 0.2.1-rc.2
                // 之前的效果，也是 DSH 网页端的做法。
                activate: true,
                // 开场快照的历史深度。默认只有 50 条，不足以回填逐轮花费；
                // 调大只让第一帧大一点，后面的推送不受影响。
                maxMessages: FOLLOW_SNAPSHOT_MESSAGES
              }
            }
          }
        }));
      } catch (error) {
        console.error('[dsh-client] failed to open session/follow:', error?.message ?? error);
        // 发送失败时不能把该会话永久记为已订阅；结束传输，让上层重连并重放。
        sessionToStream.delete(sessionId);
        streamToSession.delete(streamId);
        followed.delete(sessionId);
        endStream();
      }
    };
    // 打开提问/审批的事件通道
    const sendOpenEvents = () => {
      if (ended || !socketOpen || eventStreamId) return;
      const streamId = randomUUID();
      eventStreamId = streamId;
      try {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: '$events',
          payload: { args: {} }
        }));
      } catch (error) {
        console.error('[dsh-client] failed to open $events stream:', error?.message ?? error);
        eventStreamId = null;
        endStream();
      }
    };
    // 连上了：订阅所有要看的会话
    const handleOpen = () => {
      if (ended || sig.aborted) return;
      socketOpen = true;
      this._muxSendOpen = sendOpen;
      // 重放**全部**期望 follow（跨重连保留），而不只是本次连接排队的那些。
      // 少了这一步，DSH 一重启，所有已存在的 QQ 会话就会静默失联。
      for (const sid of this._desiredFollows) sendOpen(sid);
      sendOpenEvents();
      if (!ended) onOpen?.();
    };
    // 处理收到的每一帧数据
    const handleMessage = (event) => {
      let msg;
      try {
        if (typeof event.data !== 'string') throw new Error('binary frame');
        msg = JSON.parse(event.data);
        if (!msg || typeof msg.type !== 'string' || typeof msg.streamId !== 'string') throw new Error('unexpected remote stream frame');
      } catch (error) {
        console.error('[dsh-client] dropping malformed remote.mux frame:', error?.message ?? error);
        return;
      }
      const sessionId = streamToSession.get(msg.streamId);
      const isEventStream = msg.streamId === eventStreamId;
      if (msg.type === 'item') {
        if (isEventStream && msg.value) {
          const value = msg.value;
          if (value.type === 'ready') {
            eventClientId = value.clientId;
          } else if (value.type === 'waterfall' && eventClientId) {
            if (value.event === 'approval/request') {
              enqueue({
                kind: 'frame',
                envelope: {
                  rpcId: value.eventId,
                  payload: {
                    type: 'approval/requested',
                    sessionId: value.agentId,
                    clientId: eventClientId,
                    eventId: value.eventId,
                    toolName: value.request?.toolName,
                    callId: value.request?.callId,
                    reason: value.request?.reason
                  }
                }
              });
            } else if (value.event === 'user-questions/request') {
              enqueue({
                kind: 'frame',
                envelope: {
                  rpcId: value.eventId,
                  payload: {
                    type: 'question/requested',
                    sessionId: value.agentId,
                    clientId: eventClientId,
                    eventId: value.eventId,
                    questions: value.request?.questions
                  }
                }
              });
            }
            // 其他 emit/waterfall 事件当前桥接不需要，保持忽略。
          }
          // emit/cancel 帧忽略
        } else if (sessionId && msg.value?.type === 'event') {
          enqueue({
            kind: 'frame',
            envelope: {
              rpcId: msg.streamId,
              payload: { type: 'session/event', sessionId, event: msg.value.event }
            }
          });
        } else if (sessionId && msg.value?.type === 'snapshot') {
          // 打开/重连单会话流时的开场快照：带 projections（整条日志的权威 token 累计）
          // 与 records（最多 maxMessages 条历史事件）。
          // **单独一种帧类型**下发，绝不混进 session/event：快照里含历史 turn 的
          // turn/end，若走事件通道会让桥接把「早已结束的回合」当成新的回合去发 QQ 回复。
          enqueue({
            kind: 'frame',
            envelope: {
              rpcId: msg.streamId,
              payload: { type: 'session/snapshot', sessionId, snapshot: msg.value }
            }
          });
        }
        // 其余 snapshot 之外的帧（assistant-stream 等）当前桥接不需要，保持忽略。
      } else if (msg.type === 'end') {
        if (isEventStream) {
          eventStreamId = null;
          eventClientId = null;
          // 仅清掉 id 会让提问/审批通道永久失联；结束 mux 由桥接重连并重开。
          endStream();
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
          // 服务端结束了这条会话流（归档、空闲清理等）。
          // 不重新订阅的话，这个聊天就永远收不到消息了。
          if (this._desiredFollows.has(sessionId)) {
            console.error(`[dsh-client] session/follow 已被服务端结束，重新订阅：${sessionId}`);
            setTimeout(() => {
              if (!ended && this._desiredFollows.has(sessionId)) sendOpen(sessionId);
            }, 2000);
          }
        }
      } else if (msg.type === 'error') {
        if (isEventStream) {
          console.error('[dsh-client] $events stream failed:', msg.error?.code || 'unknown error');
          eventStreamId = null;
          eventClientId = null;
          endStream();
        } else if (sessionId) {
          sessionToStream.delete(sessionId);
          streamToSession.delete(msg.streamId);
          followed.delete(sessionId);
          // 只有已不存在的会话才永久取消订阅；临时服务错误必须在重连后重试。
          if (msg.error?.code === 'session/not-found') this._desiredFollows.delete(sessionId);
          enqueue({
            kind: 'frame',
            envelope: { rpcId: msg.streamId, payload: { type: 'stream/error', error: msg.error } }
          });
          if (msg.error?.code !== 'session/not-found') endStream();
        }
      }
    };
    // 连接关闭就结束
    const handleClose = () => endStream();
    // 连接出错就结束
    const handleError = () => endStream();
    // 被取消时结束并关闭连接
    const handleAbort = () => {
      endStream();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    };
    socket.addEventListener('open', handleOpen);
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', handleClose, { once: true });
    socket.addEventListener('error', handleError, { once: true });
    sig.addEventListener('abort', handleAbort, { once: true });
    if (sig.aborted) handleAbort();
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.kind === 'end') return;
          yield item.envelope;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      if (this._muxSendOpen === sendOpen) this._muxSendOpen = null;
      sig.removeEventListener('abort', handleAbort);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('close', handleClose);
      socket.removeEventListener('error', handleError);
      own?.abort();
      handleAbort();
    }
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    },
    /** 当前仍在跟踪（有 start 无 end）的回合数。供调用方判断 collector 是否已成空壳。 */
    size() {
      return turns.size;
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
