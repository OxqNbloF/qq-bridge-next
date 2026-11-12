// 读取 config.json 并套默认值；读坏就抛，不静默回落
import { normalizeOwnerQQ, normalizeIdList } from '../policy/access.js';
import { REASONING_EFFORT_DEFAULT, normalizeReasoningEffort } from '../policy/mode.js';
import { DEFAULT_SOCIAL_V2_TOOLS, resolveSocialV2Tools } from '../policy/tool-defaults.js';

// 读取配置并合并默认值
export function loadConfig({ configFile, readJsonSafe, discoverDshLaunchToken, log = () => {}, roleInjectMaxCharsDefault = 8000 }) {
  const p = configFile;
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 能看图的模型没配置时用这个默认值
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // DSH API 鉴权 token，默认 Bearer
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 launch token 发往非回环地址（默认否）
      allowRemote: false,
      autoDiscoverPort: true,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 非空则所有会话固定用该目录
    sessionCwd: file.sessionCwd ?? '',
    // per-conversation：每会话独立目录；shared：共用
    sessionWorkspace: file.sessionWorkspace ?? 'per-conversation',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    ignore: { sendQQ: normalizeIdList(file.ignore?.sendQQ ?? file.ignore?.senders ?? []) },
    // 白名单都为空时是否放行所有
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    // 回合卡死多久无事件就中断该会话；0 关
    turnStallMs: file.turnStallMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项，留空用默认价
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 观望阶段
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 回复时附带上最近多少条聊天记录
      // 活跃阶段
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退场
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃最长时长下限
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃最长时长上限
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时试探一句的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口
      // 观望期主动开话题
      proactiveEnabled: true,
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默
      skipProbability: 0.15,          // 普通闲聊沉默概率
      surrenderProbability: 0,        // 已弃用，保留兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息长度上限
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 按空格分条发送
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率
      longGapMinMs: 2500,             // 长间隔下限
      longGapMaxMs: 5000,             // 长间隔上限
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: { ...DEFAULT_SOCIAL_V2_TOOLS }, // 默认表见 src/policy/tool-defaults.js
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关
        preSleepWaitMs: 300000,          // 沉睡前至少观察 5 分钟
        recommendedDefaultInfinite: true, // 下次唤醒默认是否无限期
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久，防抢话
      },
      sticker: {
        enabled: true,             // 表情总开关
        syncTtlMs: 60000,          // 收藏表情缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在提示里附带表情摘要
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      // 初始提示词字数上限，防误粘长文
      initialPromptMaxChars: 2000,
      // 图片/表情数量与体积上限，默认 8MB
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // tools 与默认值深度合并，防丢新开关
  cfg.socialV2.tools = resolveSocialV2Tools(cfg.socialV2.tools);

  // 语音默认关闭；AI 只能从语音库取文件
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量须本地调好再发，网关无增益字段
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // sticker.collect 深度合并默认值
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // media 深度合并，否则缺失即无上限
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // 初始提示词上限收敛到安全区间
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // 自动找到的 token 只是保底；同时记下用户有没有自己填
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 规范化非法思考强度并告警
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 时长类配置非数字或负数直接拒绝启动
  for (const [label, value] of [['turnStallMs', cfg.turnStallMs], ['socialV2.flushIntervalMs', cfg.socialV2?.flushIntervalMs]]) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`配置 ${label} 非法：${JSON.stringify(value)}（只能是 ≥ 0 的毫秒数，0 = 关）`);
    }
  }
  if (!['per-conversation', 'shared'].includes(cfg.sessionWorkspace)) {
    throw new Error(`配置 sessionWorkspace 非法：${JSON.stringify(cfg.sessionWorkspace)}（只能是 "per-conversation" 或 "shared"）`);
  }
  // 人格卡最多写进提示词多少字
  cfg.role = {
    maxInjectChars: roleInjectMaxCharsDefault,
    // 每 N 次叫醒给一次完整角色卡；0 或 1 表示每次都给
    injectEveryNWakes: 4,
    // 窗口内重复构建沿用上次判定；0 关
    injectDedupeWindowMs: 8000,
    ...(file.role ?? {})
  };
  // 这个上限在一定范围内取值，由调用方校正

  // 消息存档默认关闭，打开会把聊天原文存到硬盘
  {
    const archive = file.archive && typeof file.archive === 'object' && !Array.isArray(file.archive) ? file.archive : {};
    const retention = Number(archive.retentionDays);
    const maxShardMb = Number(archive.maxShardMb);
    cfg.archive = {
      enabled: archive.enabled === true,
      retentionDays: Number.isFinite(retention) && retention >= 0 ? retention : 90,
      maxShardMb: Number.isFinite(maxShardMb) && maxShardMb >= 1 ? Math.min(maxShardMb, 1024) : 64,
    };
  }

  // 记忆压缩默认关闭，需要先打开消息存档
  {
    const memory = file.memory && typeof file.memory === 'object' && !Array.isArray(file.memory) ? file.memory : {};
    cfg.memory = { ...memory, enabled: memory.enabled === true };
  }

  return cfg;
}
