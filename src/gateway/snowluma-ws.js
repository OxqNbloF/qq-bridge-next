// 把 SnowLuma 的事件接到桥接各处，并建立第一次连接

export function createSnowlumaWs(b) {
  // 开始接收 SnowLuma 的事件
  function startSnowlumaClient(bot) {
    bot.onPrivateMessage(async (event) => {
      // 自己发的消息跳过，免得 AI 回自己
      if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
      try { await b.handleIncoming('private', event.user_id, event, b.cfg); } catch (error) { b.log('处理私聊消息出错:', error?.message ?? error); }
    });
    bot.onGroupMessage(async (event) => {
      if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
        || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
      try { await b.handleIncoming('group', event.group_id, event, b.cfg); } catch (error) { b.log('处理群消息出错:', error?.message ?? error); }
    });
    bot.onNotice('notify', async (event) => {
      try { await b.handlePokeNotice(event); } catch (error) { b.log('处理拍一拍事件出错:', error?.message ?? error); }
    });
    // 撤回是单独的事件类型，不在拍一拍里
    for (const noticeType of ['group_recall', 'friend_recall']) {
      try {
        bot.onNotice(noticeType, async (event) => {
          try { b.handleRecallNotice({ ...event, notice_type: noticeType }); }
          catch (error) { b.log('处理撤回事件出错:', error?.message ?? error); }
        });
      } catch (error) {
        // 不同 OneBot 版本的订阅方法可能不同，失败也不影响收发
        b.log(`（撤回事件订阅不可用 ${noticeType}：${error?.message ?? error}）`);
      }
    }

    // 顺带记下 SnowLuma 还活着；心跳里还带接收是否正常
    try {
      bot.onEvent((event) => {
        const post = event?.post_type;
        b.noteUpstreamPacket(post
          ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
          : 'event');
        if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
          // 心跳里的 status 没写进类型声明，但能直接读
          b.noteReceiveHealth(event.status?.good, 'heartbeat');
          if (typeof event.status?.online === 'boolean') b.snowlumaHealth.accountOnline = event.status.online;
          b.reportSnowlumaHealth();
        }
      });
    } catch (error) {
      b.log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
    }

    // 新版本才有账号上下线事件，收不到也不影响判断
    try {
      bot.onBotStatus((event) => {
        b.noteUpstreamPacket('notice/bot_status');
        const sub = String(event?.sub_type ?? '');
        b.snowlumaHealth.accountOnline = sub === 'online';
        if (sub === 'offline') {
          b.log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
            + '在重新登录之前群里不会有任何消息进来。');
        } else if (sub === 'online') {
          b.log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
        }
      });
    } catch (error) {
      b.log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
    }

    bot.on('open', () => {
      // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
      const connectedUrl = bot.url ?? b.cfg.snowluma.wsUrl;
      b.snowlumaHealth.connected = true;
      b.log(`SnowLuma 已连接：${connectedUrl}`);
      // 连上只代表 WebSocket 通，不代表 QQ 消息收得到
      void b.pollSnowlumaStatus();
      // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
      bot.getLoginInfo().then((login) => {
        if (login?.nickname) {
          b.selfNickname = String(login.nickname).toLowerCase();
          b.selfDisplayName = String(login.nickname).trim();
          b.log(`机器人昵称: ${login.nickname}`);
        }
        if (login?.user_id != null) b.selfUserId = String(login.user_id);
      }).catch(() => {});
      // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
      // 让 MCP 工具（另一个进程）也能拿到正确的 token。
      void b.syncTokenToFile();
    });

    bot.on('close', (info) => {
      b.snowlumaHealth.connected = false;
      b.log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
      // 每次启动都可能断一次：HTTP 和 WS 的令牌不是同一个
      void b.healTokenIfStale(`close code=${info?.code ?? '?'}`);
    });
    bot.on('error', (error) => {
      // 被拒时可能只报错不断开，这里也试着换令牌
      const detail = error && typeof error === 'object'
        ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
        : String(error ?? '');
      b.log(`SnowLuma 错误：${detail || '(无详情)'}`);
      void b.healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
    });

    // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
    bot.connect().catch((error) => {
      // 第一次连不上多半正常：两种令牌不同，会自动换对的再连
      b.log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
    });
  }

  return { startSnowlumaClient };
}
