import { adaptLegacyConfig } from './legacy-config.js';
// 读取 config.json 并套默认值；读坏就抛，不静默回落
import { normalizeOwnerQQ, normalizeIdList } from '../policy/access.js';
import { REASONING_EFFORT_DEFAULT, normalizeReasoningEffort } from '../policy/mode.js';
import { DEFAULT_SOCIAL_V2_TOOLS, resolveSocialV2Tools } from '../policy/tool-defaults.js';

// config.json 读-改-写串行锁：防止控制台并发写入导致 TOCTOU 互相覆盖
let configWriteChain = Promise.resolve();
export function withConfigWriteLock(fn) {
  const run = configWriteChain.catch(() => {}).then(() => fn());
  configWriteChain = run.catch(() => {});
  return run;
}

// 有界纯对象深合并：嵌套配置局部覆盖时保留同级默认值（如 wake/send/wait/proactive/feedback/context）
export const isPlainConfigObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export function deepMergePlain(defaults, override, depth = 0) {
  if (!isPlainConfigObject(override) || depth > 8) return defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(override)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    if (isPlainConfigObject(out[k])) {
      if (!isPlainConfigObject(v)) throw new TypeError(`配置字段 ${k} 必须是对象`);
      out[k] = deepMergePlain(out[k], v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 读取配置并合并默认值
export function loadConfig({ configFile, readJsonSafe, discoverDshLaunchToken, log = () => {}, roleInjectMaxCharsDefault = 8000 }) {
  const p = configFile;
  const raw = readJsonSafe(p, null, true);
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? adaptLegacyConfig(raw) : raw;
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  for (const groupKey of ['dsh', 'snowluma', 'security', 'role', 'identity']) {
    if (file[groupKey] !== undefined && !isPlainConfigObject(file[groupKey])) {
      throw new TypeError(`配置 ${groupKey} 必须是对象`);
    }
  }
  if (file.consolePort !== undefined) {
    const cp = Number(file.consolePort);
    if (!Number.isInteger(cp) || cp < 1 || cp > 65535) {
      throw new RangeError(`配置 consolePort 必须是 1~65535 的整数`);
    }
  }
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
      inlineDispatch: false,
      autoDiscoverPort: true,
      ...(file.dsh ?? {})
    },
    snowluma: {
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',
      accessToken: '',
      followDiscoveredEndpoint: true,
      silenceWarnMs: 600000,
      launcherPath: '',
      homeDir: '',
      ...(file.snowluma ?? {})
    },
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
    ackMessage: file.ackMessage ?? '',
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
    webSearch: deepMergePlain({
      provider: 'auto',
      apiKey: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: '',
      model: 'deepseek-v4-flash',
      maxUses: 5,
      maxTokens: 4096,
      maxResults: 8,
      timeoutMs: 35000,
    }, file.webSearch),
    social: deepMergePlain({
      enabled: true,
      // 观望阶段
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 回复时附带上最近多少条聊天记录
      // 活跃阶段
      activeCheckMinMs: 8 * 1000,     // 活跃期检测间隔
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 1 * 1000, // 活跃期回复延迟
      activeReplyDelayMaxMs: 5 * 1000,
      // 活跃超时主动退场
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 20 * 60 * 1000, // 活跃最长时长下限
      activeDurationMaxMs: 50 * 60 * 1000, // 活跃最长时长上限
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.4,      // 冷场时试探一句的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口
      // 观望期主动开话题
      proactiveEnabled: true,
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默
      skipProbability: 0.05,          // 普通闲聊沉默概率
      surrenderProbability: 0,        // 已弃用，保留兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息长度上限
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 按空格分条发送
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.2,        // 长间隔概率
      longGapMinMs: 5000,             // 长间隔下限
      longGapMaxMs: 10000,            // 长间隔上限
    }, file.social),
    socialV2: deepMergePlain({
      enabled: true,
      flushIntervalMs: 1000,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: { ...DEFAULT_SOCIAL_V2_TOOLS }, // 默认表见 src/policy/tool-defaults.js
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关
        preSleepWaitMs: 300000,          // 沉睡前至少观察 5 分钟
        staleChatMinutes: 10,
        staleSilentMinutes: 120,
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
        recommendedHint: '单条消息不要用空格断句，中文短句用逗号/顿号或直接连写；分条时每条都要读起来完整，不要把同一句话拆到两条里；普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
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
      voice: {
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
        maxCount: 5,
        normalize: true,
        maxModelBytes: 1048576,
        maxLongEdge: 1280,
        gifFrames: 6,
        gifTile: 240,
        normalizeTimeoutMs: 25000,
      }
    }, file.socialV2)
  };

  // tools 与默认值深度合并，防丢新开关
  cfg.socialV2.tools = resolveSocialV2Tools(cfg.socialV2.tools);

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
    cfg.memory = { ...memory, enabled: memory.enabled === true, learnerPreset: memory.learnerPreset ?? file.slang?.learnerPreset ?? 'qq-chat', workspaceTitle: memory.workspaceTitle ?? file.slang?.workspaceTitle ?? 'QQ 记忆整理', terms: { enabled: true, injectMax: 8, maxPerConv: 200, ...file.slang, ...memory.terms } };
    delete cfg.memory.terms.learnerPreset;
    delete cfg.memory.terms.workspaceTitle;
    delete cfg.memory.terms.autoResearch;
    delete cfg.memory.terms.extractMinMessages;
    delete cfg.memory.terms.extractCooldownMs;
    delete cfg.memory.terms.inferenceThresholds;
  }

  cfg.identity = { enabled: true, learnFromChat: true, renderAliasTableMax: 20, ...file.identity, exposeQqInPrompt: file.identity?.exposeQqInPrompt ?? cfg.socialV2?.privacy?.exposeUserId === true };

  // 架构改造灰度开关，默认全关（docs/architecture-refactor.md §12）
  cfg.modes = {
    engine: Object.fromEntries(['chat', 'closed-agent', 'reserved', 'reserved2'].map((mode) => [mode, file.modes?.engine?.[mode] === true])),
    defaults: Object.fromEntries(['group', 'private'].flatMap((kind) => {
      const mode = file.modes?.defaults?.[kind];
      if (mode === undefined) return [];
      if (!['chat', 'reserved', 'reserved2'].includes(mode)) throw new Error(`modes.defaults.${kind} 只允许 chat/reserved/reserved2`);
      return [[kind, mode]];
    })),
  };
  cfg.architecture = {
    gateV2: file.architecture?.gateV2 === true,
    schedulerV2: {
      ...Object.fromEntries(['chat', 'closed-agent', 'reserved', 'reserved2', 'shadow'].map((mode) => [mode, file.architecture?.schedulerV2?.[mode] === true])),
      maxConcurrent: Math.min(64, Math.max(1, Math.floor(Number(file.architecture?.schedulerV2?.maxConcurrent) || 4))),
    },
  };
  return cfg;
}
