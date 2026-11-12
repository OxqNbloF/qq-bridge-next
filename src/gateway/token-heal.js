// SnowLuma 换账号后，token 和地址会变，这里负责自动换新的
// 不修的话，桥接看着活着，其实消息一条都收不到、发不出

/**
 * @param {object} o
 * @param {object} o.cfg
 * @param {object} o.bot 连接对象，会自动改里面的 token 和地址
 * @param {string} o.configFile
 * @param {(...a:any[])=>void} o.log
 * @param {Function} o.persistSnowLumaEndpoint
 * @param {Function} o.persistToken
 * @param {Function} o.discoverSnowLumaConnection
 * @param {() => number} [o.now]
 */
export function createTokenHeal({ cfg, bot, configFile, log, persistSnowLumaEndpoint, persistToken, discoverSnowLumaConnection, now = () => Date.now() }) {
  /**
   * 把找到的新 token 和地址用上；收消息和连网页各用一个 token。
   */
  async function applyHealedTokens(r) {
    // 默认会跟着找到的地址走；配置里可以关掉，改用手写的地址
    // 关掉后只更新地址一样的那部分，不会把别的程序登录信息套过来
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    // 看看两个地址是不是同一个
    const sameEndpoint = (a, b) => {
      try { return new URL(String(a)).href.replace(/\/+$/, '') === new URL(String(b)).href.replace(/\/+$/, ''); }
      catch { return false; }
    };
    const acceptHttpToken = followEndpoint || sameEndpoint(r.baseUrl, cfg.snowluma.httpUrl || 'http://127.0.0.1:3000');
    const acceptWsToken = !!r.wsUrl && typeof r.wsToken === 'string'
      && (followEndpoint || sameEndpoint(r.wsUrl, cfg.snowluma.wsUrl));
    const httpToken = acceptHttpToken ? r.token : cfg.snowluma.accessToken;
    const wsToken = (acceptWsToken ? r.wsToken : bot.accessToken) || undefined;
    const wsUrl = followEndpoint && acceptWsToken ? r.wsUrl : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken;
    // 换账号后端口也会变，只换 token 不换地址会一直重连失败
    bot.url = wsUrl;
    if (wsChanged) log('🔄 SnowLuma WS 连接已更新');
    if (acceptHttpToken && cfg.snowluma.accessToken !== httpToken) {
      log('🔄 SnowLuma HTTP token 已更新');
      cfg.snowluma.accessToken = httpToken;
    }
    if (!acceptHttpToken || !acceptWsToken) {
      log('   已按 snowluma.followDiscoveredEndpoint=false 忽略其他端点及其凭据');
    }
    // 把确认能用的地址写回配置文件，下次启动就不用再找一遍
    // 关掉地址跟随时不写地址，免得把用户自己写的地址覆盖掉
    cfg.snowluma.wsUrl = wsUrl;
    if (followEndpoint && r.baseUrl) cfg.snowluma.httpUrl = r.baseUrl;
    try {
      const w = persistSnowLumaEndpoint(configFile, {
        ...(acceptHttpToken ? { accessToken: httpToken } : {}),
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(configFile, cfg.snowluma.accessToken ?? '');
      // 日志里不打印 token 的任何部分，截图贴出去会泄露
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  // 连不上时重新找 token，十秒内只试一次
  async function healTokenIfStale(reason) {
    const t = now();
    if (t - tokenHealAt < 10000) return;   // 十秒内只试一次，断开事件会连着来
    tokenHealAt = t;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  return { applyHealedTokens, syncTokenToFile, healTokenIfStale };
}
