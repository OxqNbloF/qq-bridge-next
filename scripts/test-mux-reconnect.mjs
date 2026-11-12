// 测试断线重连后，已有会话还能不能继续收到消息。
// 旧代码在重连后会忘记之前订阅的会话，
// 表现为消息发出去了却永远收不到回复，而且不报错。
// 这里用假的网络连接模拟断开，不需要真的 DSH。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frames = [];
const sockets = [];

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.readyState = FakeWebSocket.CONNECTING;
    this._listeners = new Map();
    sockets.push(this);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  send(data) { frames.push({ socket: this, frame: JSON.parse(data) }); }
  close() { this.readyState = FakeWebSocket.CLOSED; this._emit('close', {}); }
  _emit(type, ev) { for (const fn of this._listeners.get(type) ?? []) fn(ev); }
  simulateOpen() { this.readyState = FakeWebSocket.OPEN; this._emit('open', {}); }
}
globalThis.WebSocket = FakeWebSocket;

const { NodeApiClient } = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);
const client = new NodeApiClient('http://127.0.0.1:3080', undefined, {});
// 跳过真的登录：这里只关心重连后会不会重新订阅
client.ensureAuth = async () => { client.cookie = 'test-cookie'; };

// 等一小会儿再继续
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// 打开事件流，并把它收的消息都丢掉
const startStream = () => {
  const stream = client.events.mux({}, undefined, () => {});
  const it = stream[Symbol.asyncIterator]();
  (async () => { try { for await (const _ of it) { /* 把消息丢掉 */ } } catch { /* 出错就不用管 */ } })();
  return stream;
};
// 看某条连接上发出了哪些订阅会话的请求
const followsOn = (socket) => frames
  .filter((f) => f.socket === socket && f.frame.endpoint === 'session/follow')
  .map((f) => f.frame.payload.args.request.address.sessionId);

let failed = 0;
// 记一次检查结果，错了就记一次失败
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

// 连接 1：follow 一个已有会话
const s1 = startStream();
await tick();
sockets[0].simulateOpen();
await tick();
s1.follow('session-AAA');
await tick();
check('首连即 follow 目标会话', followsOn(sockets[0]).includes('session-AAA'), `[${followsOn(sockets[0]).join(', ')}]`);
check('$events 附加流已打开', frames.some((f) => f.socket === sockets[0] && f.frame.endpoint === '$events'));

// 模拟 DSH 重启 / WS 断开
sockets[0].close();
await tick(60);

// 连接 2：重连，看旧会话会不会被重新订阅
startStream();
await tick();
sockets[1].simulateOpen();
await tick(60);
check('重连后重放了已有会话的 follow', followsOn(sockets[1]).includes('session-AAA'), `[${followsOn(sockets[1]).join(', ')}]`);

console.log(failed === 0 ? '\n✅ 事件流重连回归测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
