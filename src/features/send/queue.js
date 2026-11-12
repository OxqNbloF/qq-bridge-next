// 发 QQ 消息时按会话排队，一个会话一个接一个发，避免太频繁
// 另外记着上次发送有没有失败

export function createSendQueue(b) {
  // QQ 发送队列：同一个聊天里一条接一条发，中间留点间隔
  // 每个聊天单独排队，一个群刷屏不会把别的群拖慢
  // 只有同一个聊天里的消息需要按顺序，不同聊天各走各的
  const sendChains = new Map();
  // 把聊天编号统一成字符串当钥匙
  const sendChainKey = (key) => String(key);
  // 取出这个聊天的排队链，没有就从空的开始
  const sendChainFor = (key) => sendChains.get(sendChainKey(key)) ?? Promise.resolve();
  /** 记回该会话的链尾；链跑完后若没有新的追加就把条目删掉（避免 Map 无界增长）。 */
  function rememberSendChain(key, chain) {
    const canonical = sendChainKey(key);
    sendChains.set(canonical, chain);
    // 这条链跑完了就从表里删掉，免得越积越多
    const cleanup = () => { if (sendChains.get(canonical) === chain) sendChains.delete(canonical); };
    chain.then(cleanup, cleanup);
    return chain;
  }

  // 记下每个聊天上次发送有没有失败
  // 失败时别当成发出去了，否则会误以为已经说过话
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）


  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  return { sendChainKey, sendChainFor, rememberSendChain, lastSendSucceeded, lastSendFailed };
}
