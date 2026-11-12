// 把「等一会」和「超时放弃」包好，定时器从外面传进来，方便测试

/** 把延迟限制在有限范围内，防止溢出变成 1ms 忙循环 */
export function boundedTimerDelay(value, fallback = 0, min = 0, max = 86400000) {
  const n = Number(value);
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : fallback)));
}

/**
 * 用外面传进来的定时器做出「等一会」和「超时放弃」两个工具。
 * @param {object} timers 提供两个定时器函数的对象
 * @returns {object} sleep 和 withTimeout 两个函数
 */
export function createAsyncHelpers({ setTimeout: setT, clearTimeout: clearT }) {
  // codeql[js/resource-exhaustion]: 延迟已限制在合理范围内
  const sleep = (ms) => new Promise((r) => setT(r, boundedTimerDelay(ms)));
  // 等太久就报错放弃，结束后把定时器清掉
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setT(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearT(timer));
  }
  return { sleep, withTimeout };
}
