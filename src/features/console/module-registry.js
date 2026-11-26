// 工作台 14 大模块统一参数注册表（单一事实来源）：
// 声明每个模块的内部参数路径、类型、范围、生效方式（hot/restart）与安全边界（public/secret/localOnly）。
import { loadConfig, deepMergePlain, isPlainConfigObject } from '../../infra/config.js';
import { migrateLegacyConfig } from '../../infra/legacy-config.js';
import { normalizeOwnerQQ, normalizeIdList } from '../../policy/access.js';
import { REASONING_EFFORT_OPTIONS, REASONING_EFFORT_NONE, normalizeReasoningEffort } from '../../policy/mode.js';
import { SOCIAL_V2_TOOL_FLAGS, SOCIAL_V2_TOOL_PROMPT_MAP } from '../../policy/tool-defaults.js';

const TOOL_LABEL_MAP = {
  getPrompt: '读取提示词 (qq_get_prompt)',
  getUnread: '读取未读 (qq_get_unread_messages)',
  getRecent: '读取最近消息 (qq_get_recent_messages)',
  socialState: '查看调度状态 (qq_social_state)',
  sendGroup: '发送群消息 (qq_send_group_message)',
  sendPrivate: '发送私聊 (qq_send_private_message)',
  reply: '引用回复 (qq_reply)',
  sendBurst: '多条连发 (qq_send_burst)',
  sendMessage: '统一发送 (qq_send_message)',
  waitMessages: '等待新消息 (qq_wait_for_messages)',
  feedback: '提交反馈 (qq_report_feedback)',
  getMyRecent: '查看自身发言 (qq_get_my_recent_messages)',
  getMessageDetail: '查看消息详情 (qq_get_message_detail)',
  getActiveMembers: '活跃成员 (qq_get_active_members)',
  getGroupMembers: '群成员分页列表 (qq_get_group_members)',
  setWakeConfig: '调整唤醒条件 (qq_set_wake_config)',
  markRead: '标记已读 (qq_mark_read)',
  memory: '轻量记忆与印象 (qq_memory_*)',
  getImages: '读取消息图片 (qq_get_message_images)',
  getForwardMsg: '读取合并转发 (qq_get_forward_msg)',
  sendPoke: '发送拍一拍 (qq_send_poke)',
  listStickers: '列出收藏表情 (qq_list_stickers)',
  getStickerImage: '查看表情图片 (qq_get_sticker_image)',
  sendSticker: '发送表情 (qq_send_sticker)',
  setStickerRemark: '修改官方表情备注 (qq_set_sticker_remark)',
  stickerNote: '记录本地表情笔记 (qq_sticker_note)',
  collectSticker: '收藏他人表情 (qq_collect_sticker)',
  getSelfImage: '查看自身形象 (qq_get_self_image)',
  sendVoice: '发送语音与列表 (qq_send_voice)',
};

const f = (path, label, type, extra = {}) => ({
  path,
  label,
  type,
  applyMode: extra.applyMode ?? 'hot',
  sensitivity: extra.sensitivity ?? 'public',
  section: extra.section ?? '基础参数',
  description: extra.description ?? '',
  ...extra,
});

const TOOL_FIELDS = SOCIAL_V2_TOOL_FLAGS.map((flag) => {
  const mcp = SOCIAL_V2_TOOL_PROMPT_MAP[flag] || flag;
  return f(
    `modes.reserved2.tools.${flag}`,
    TOOL_LABEL_MAP[flag] || `${flag} (${mcp})`,
    'boolean',
    {
      section: '工具权限开关（共 29 项）',
      applyMode: 'hot',
      description: `MCP 工具：${mcp}（关闭后即刻拒绝调用；重启 DSH 后同步刷新工具清单）`,
    }
  );
});

/** 全部 13 大功能模块定义 */
export const MODULE_DEFINITIONS = Object.freeze([
  {
    id: 'core',
    title: '基础运行与全局控制',
    category: '系统基础',
    description: '控制回复确认提示、默认发送延迟、审批/卡死超时与全局工作区会话策略。',
    fields: [
      f('ackMessage', '收到消息确认提示', 'string', { section: '消息交互', description: '普通聊天模式下收到消息时的即时占位提示；留空关闭' }),
      f('sendDelayMs', '默认发送间隔', 'integer', { section: '消息交互', min: 0, max: 60000, unit: 'ms', description: '连续多段发送之间的基础等待时间' }),
      f('questionTimeoutMs', '审批/提问超时', 'integer', { section: '超时与保护', min: 10000, max: 3600000, unit: 'ms', description: '等待管理员回复提问或权限审批的最长时间' }),
      f('turnStallMs', '回合卡死检测阈值', 'integer', { section: '超时与保护', min: 0, max: 3600000, unit: 'ms', description: '超过该时间无事件则判定卡死中断；0 表示关闭' }),
      f('agentPreset', '默认聊天预设', 'string', { section: '会话工作区', applyMode: 'restart', description: '普通聊天/一代仿真使用的 DSH Agent 预设名' }),
      f('workspaceTitle', '工作区显示标题', 'string', { section: '会话工作区', applyMode: 'restart', description: '在 DSH 中创建的聊天工作区名称' }),
      f('sessionWorkspace', '工作目录隔离策略', 'enum', { section: '会话工作区', applyMode: 'restart', options: ['per-conversation', 'shared'], description: 'per-conversation 按会话隔离目录；shared 共用目录' }),
      f('allowAllWhenEmpty', '空白名单时放行全部会话', 'boolean', { section: '安全开关', applyMode: 'hot', description: '默认关闭（建议保持关闭，明确维护白名单）' }),
      f('consolePort', '控制台监听端口', 'integer', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
      f('sessionCwd', '固定会话工作目录', 'string', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
    ],
  },
  {
    id: 'dsh',
    title: 'DSH 连接与模型',
    category: '上游连接',
    description: '管理 DeepSeek Harness Web API 地址、模型服务商、模型名称、思考强度与鉴权方式。',
    fields: [
      f('dsh.provider', '模型服务商 (provider)', 'string', { section: '模型参数', applyMode: 'hot', description: 'DSH 中已配置的模型提供方 ID，保存后下条消息生效' }),
      f('dsh.model', '模型名称 (model)', 'string', { section: '模型参数', applyMode: 'hot', description: '目标模型 ID（如 deepseek-flash / deepseek-pro）' }),
      f('dsh.reasoningEffort', '思考强度 (reasoningEffort)', 'enum', { section: '模型参数', applyMode: 'hot', options: [...REASONING_EFFORT_OPTIONS, REASONING_EFFORT_NONE], description: '切换思考强度后下一条消息重新选模型生效' }),
      f('dsh.baseUrl', 'DSH Web 地址', 'string', { section: '连接设置', applyMode: 'restart', description: '默认 http://127.0.0.1:3080' }),
      f('dsh.autoDiscoverPort', '自动发现桌面版随机端口', 'boolean', { section: '连接设置', applyMode: 'hot', description: 'DSH 断连时自动扫描本机日志恢复新端口' }),
      f('dsh.inlineDispatch', '内联事件分发', 'boolean', { section: '连接设置', applyMode: 'restart', description: '高级调试开关，常规部署保持关闭' }),
      f('dsh.allowRemote', '允许非回环地址发送凭证', 'boolean', { section: '鉴权设置', applyMode: 'restart', description: '仅跨机安全内网部署时开启' }),
      f('dsh.authHeader', '鉴权请求头名称', 'string', { section: '鉴权设置', applyMode: 'restart', description: '默认 authorization' }),
      f('dsh.authPrefix', '鉴权前缀', 'string', { section: '鉴权设置', applyMode: 'restart', description: '默认 Bearer' }),
      f('dsh.authToken', 'DSH 显式访问令牌', 'string', { section: '鉴权设置', sensitivity: 'secret', applyMode: 'restart', description: '留空不改；仅写入不回显明文' }),
    ],
  },
  {
    id: 'backend-agy',
    title: 'CLI 后端与权限 (agy / gemini)',
    category: '上游连接',
    description: '管理多后端切换（dsh / agy / gemini）、CLI 模型、超时与 --settings 工具权限热下发。',
    fields: [
      f('backend.type', '当前 Agent 后端类型', 'enum', { section: '后端切换', applyMode: 'restart', options: ['dsh', 'agy', 'gemini'], description: 'dsh 为 DeepSeek Harness；agy 为 Antigravity CLI；gemini 为 Gemini CLI（切换后重启生效）' }),
      f('backend.agy.model', 'agy 默认模型', 'string', { section: '模型与执行 (agy)', applyMode: 'hot', description: '留空使用 agy CLI 默认模型；保存后下一条消息生效' }),
      f('backend.agy.timeoutMs', 'agy 单轮执行超时', 'integer', { section: '模型与执行 (agy)', min: 10000, max: 1800000, unit: 'ms', applyMode: 'hot', description: '单次 agy 子进程执行超时时间' }),
      f('backend.agy.injectPresetPrompt', 'agy 注入安全预设提示词', 'boolean', { section: '模型与执行 (agy)', applyMode: 'hot', description: '非 closed-agent 模式首轮自动注入 qq-chat/qq-chat-v2 系统提示词' }),
      f('backend.agy.permissions.allow', '允许工具规则 (allow)', 'stringArray', { section: '工具权限（--settings 热下发）', applyMode: 'hot', description: '每轮经 --settings 下发，规则须带斜杠如 mcp(snowluma/*)；留空将拒绝全部 MCP 工具，修改后自动重置旧会话' }),
      f('backend.agy.permissions.deny', '拒绝工具规则 (deny)', 'stringArray', { section: '工具权限（--settings 热下发）', applyMode: 'hot', description: '显式拒绝规则（优先级高于 allow），修改后自动重置旧会话' }),
      f('backend.gemini.model', 'gemini 默认模型', 'string', { section: '模型与执行 (gemini)', applyMode: 'hot', description: '留空使用 Gemini CLI 默认模型；保存后下一条消息生效' }),
      f('backend.gemini.timeoutMs', 'gemini 单轮执行超时', 'integer', { section: '模型与执行 (gemini)', min: 10000, max: 1800000, unit: 'ms', applyMode: 'hot', description: '单次 gemini 子进程执行超时时间' }),
      f('backend.gemini.injectPresetPrompt', 'gemini 注入安全预设提示词', 'boolean', { section: '模型与执行 (gemini)', applyMode: 'hot', description: '非 closed-agent 模式首轮自动注入 qq-chat/qq-chat-v2 系统提示词' }),
      f('backend.agy.command', 'agy 可执行文件路径', 'string', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
      f('backend.agy.args', 'agy 额外固定参数', 'stringArray', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
      f('backend.gemini.command', 'gemini 可执行文件路径', 'string', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
      f('backend.gemini.args', 'gemini 额外固定参数', 'stringArray', { section: '本机只读项', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
    ],
  },
  {
    id: 'modular-broker',
    title: '模块化脚本连接层 (Broker)',
    category: '上游连接',
    description: '家长控制式本地脚本 Broker：外部控制台实时裁剪开放给 Agent 的模块，配合零令牌 Unix Socket 与精简增量提示词。',
    fields: [
      f('broker.enabled', '启用模块化脚本 Broker', 'boolean', { section: '核心开关', applyMode: 'hot', description: '开启后为每个受限会话注入专属 Unix Socket 与 5 工具 MCP 代理' }),
      f('broker.compactPrompt', '启用精简 Delta 提示词与随机 Nonce', 'boolean', { section: '核心开关', applyMode: 'hot', description: '开启后每轮仅下发紧凑消息增量，隔离不可信文本并大幅减少提示词冗余' }),
      f('broker.enabledModules', '开放给 Agent 的本地模块', 'stringArray', { section: '家长控制白名单', applyMode: 'hot', description: '控制台随时增删允许调用的模块（如 msg, media, memory, wake, web, social），Agent 无法触碰' }),
      f('broker.compactThresholdTokens', '上下文自动压缩阈值', 'integer', { section: '上下文与沙箱', min: 4000, max: 1000000, applyMode: 'hot', description: '当单轮 input_tokens 达到阈值时提炼 <=400 字滚动摘要并重置后端续聊' }),
      f('broker.scriptTimeoutMs', '本地模块脚本执行超时', 'integer', { section: '上下文与沙箱', min: 1000, max: 120000, unit: 'ms', applyMode: 'hot', description: '单个本地脚本执行的最长等待时间' }),
      f('broker.sandbox.useBwrap', '使用 bubblewrap (bwrap) 沙箱运行脚本', 'boolean', { section: '上下文与沙箱', applyMode: 'hot', description: 'Linux 环境可用 bwrap 隔离本地脚本文件系统' }),
    ],
  },
  {
    id: 'snowluma',
    title: 'SnowLuma 网关',
    category: '上游连接',
    description: '配置 OneBot v11 WebSocket / HTTP 网关地址、自动端点跟随与静默告警阈值。',
    fields: [
      f('snowluma.wsUrl', 'OneBot WebSocket 地址', 'string', { section: '网关端点', applyMode: 'restart', description: '默认 ws://127.0.0.1:3001' }),
      f('snowluma.httpUrl', 'OneBot HTTP API 地址', 'string', { section: '网关端点', applyMode: 'restart', description: '默认 http://127.0.0.1:3000' }),
      f('snowluma.followDiscoveredEndpoint', '跟随自动发现的账号端点', 'boolean', { section: '自愈与健康', applyMode: 'hot', description: 'SnowLuma 切换 QQ 号后自动同步新端口与令牌' }),
      f('snowluma.silenceWarnMs', '无事件包静默告警阈值', 'integer', { section: '自愈与健康', min: 60000, max: 86400000, unit: 'ms', applyMode: 'hot', description: 'WS 已连接但超过该时长无任何事件包时提示异常' }),
      f('snowluma.accessToken', 'OneBot 访问令牌', 'string', { section: '鉴权与本机路径', sensitivity: 'secret', applyMode: 'restart', description: '与 SnowLuma 配置一致；仅写入不回显明文' }),
      f('snowluma.homeDir', 'SnowLuma 安装目录', 'string', { section: '鉴权与本机路径', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
      f('snowluma.launcherPath', 'SnowLuma 启动器路径', 'string', { section: '鉴权与本机路径', sensitivity: 'localOnly', applyMode: 'restart', description: '仅可在部署机 config.json 修改' }),
    ],
  },
  {
    id: 'gate',
    title: '门禁与访问控制',
    category: '权限安全',
    description: '管理管理员 QQ、会话白/黑名单、忽略发送者清单与二代精细成员门禁开关。',
    fields: [
      f('ownerQQ', '管理员 QQ 号', 'nullableQq', { section: '管理员与名单', applyMode: 'hot', description: '留空清除管理员；仅管理员可使用管理命令与 closed-agent' }),
      f('allow.groups', '允许接入的群号', 'qqList', { section: '管理员与名单', applyMode: 'hot', description: '每行或逗号分隔一个群号' }),
      f('allow.private', '允许接入的私聊 QQ', 'qqList', { section: '管理员与名单', applyMode: 'hot', description: '每行或逗号分隔一个 QQ 号' }),
      f('deny.groups', '拒绝接入的群号黑名单', 'qqList', { section: '管理员与名单', applyMode: 'hot', description: '优先于白名单拦截' }),
      f('deny.private', '拒绝接入的私聊黑名单', 'qqList', { section: '管理员与名单', applyMode: 'hot', description: '优先于白名单拦截' }),
      f('ignore.sendQQ', '忽略的发言者 QQ', 'qqList', { section: '消息过滤', applyMode: 'hot', description: '这些 QQ 的消息直接忽略（如其他机器人）' }),
      f('architecture.gateV2', '启用二代成员门禁 (gateV2)', 'boolean', { section: '精细门禁', applyMode: 'restart', description: '开启后群聊按成员四开关策略（回应/对话/上下文/记忆）独立控制' }),
    ],
  },
  {
    id: 'scheduler',
    title: '调度引擎与模式路由',
    category: '核心引擎',
    description: '控制新调度器灰度开关、最大并发会话数、新模式引擎与按群/私聊默认模式。',
    fields: [
      f('architecture.schedulerV2.maxConcurrent', '最大并发会话数', 'integer', { section: '二代调度器', min: 1, max: 64, applyMode: 'restart', description: '同时运行 DSH 回合的会话数量上限' }),
      f('architecture.schedulerV2.chat', '普通聊天启用新调度器', 'boolean', { section: '二代调度器', applyMode: 'restart' }),
      f('architecture.schedulerV2.reserved', '一代仿真启用新调度器', 'boolean', { section: '二代调度器', applyMode: 'restart' }),
      f('architecture.schedulerV2.reserved2', '二代仿真启用新调度器', 'boolean', { section: '二代调度器', applyMode: 'restart' }),
      f('architecture.schedulerV2.closed-agent', '管理员代理启用新调度器', 'boolean', { section: '二代调度器', applyMode: 'restart' }),
      f('architecture.schedulerV2.shadow', '影子调度诊断模式', 'boolean', { section: '二代调度器', applyMode: 'restart', description: '仅记录对照事件，不实际外发' }),
      f('modes.engine.chat', 'chat 启用新模式引擎', 'boolean', { section: '模式引擎灰度', applyMode: 'restart' }),
      f('modes.engine.reserved', 'reserved 启用新模式引擎', 'boolean', { section: '模式引擎灰度', applyMode: 'restart' }),
      f('modes.engine.reserved2', 'reserved2 启用新模式引擎', 'boolean', { section: '模式引擎灰度', applyMode: 'restart' }),
      f('modes.engine.closed-agent', 'closed-agent 启用新模式引擎', 'boolean', { section: '模式引擎灰度', applyMode: 'restart' }),
      f('modes.defaults.group', '群聊默认模式覆写', 'optionalEnum', { section: '默认模式', options: ['', 'chat', 'reserved', 'reserved2'], applyMode: 'restart', description: '留空沿用全局当前模式' }),
      f('modes.defaults.private', '私聊默认模式覆写', 'optionalEnum', { section: '默认模式', options: ['', 'chat', 'reserved', 'reserved2'], applyMode: 'restart', description: '留空沿用全局当前模式' }),
    ],
  },
  {
    id: 'reserved1',
    title: '一代仿真（reserved）',
    category: '互动模式',
    description: '调节一代社交状态机的触发概率、活跃周期、冷场试探、主动开话题与分条发送节奏。',
    fields: [
      f('modes.reserved.enabled', '启用一代仿真引擎', 'boolean', { section: '基础控制' }),
      f('modes.reserved.triggerProbability', '普通消息触发活跃概率', 'number', { section: '基础控制', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.contextWindow', '上下文携带消息条数', 'integer', { section: '基础控制', min: 1, max: 100 }),
      f('modes.reserved.maxReplyChars', '单条回复最大字数', 'integer', { section: '基础控制', min: 20, max: 4000 }),
      f('modes.reserved.mustReplyKeywords', '必回触发关键词', 'stringArray', { section: '基础控制', description: '每行一个关键词' }),
      f('modes.reserved.activeCheckMinMs', '活跃期检测最短间隔', 'integer', { section: '活跃与退场', min: 1000, max: 600000, unit: 'ms' }),
      f('modes.reserved.activeCheckMaxMs', '活跃期检测最长间隔', 'integer', { section: '活跃与退场', min: 1000, max: 600000, unit: 'ms' }),
      f('modes.reserved.activeReplyDelayMinMs', '活跃期回复最短延迟', 'integer', { section: '活跃与退场', min: 0, max: 120000, unit: 'ms' }),
      f('modes.reserved.activeReplyDelayMaxMs', '活跃期回复最长延迟', 'integer', { section: '活跃与退场', min: 0, max: 120000, unit: 'ms' }),
      f('modes.reserved.activeDurationEnabled', '启用活跃超时主动退场', 'boolean', { section: '活跃与退场' }),
      f('modes.reserved.activeDurationMinMs', '活跃时长下限', 'integer', { section: '活跃与退场', min: 60000, max: 14400000, unit: 'ms' }),
      f('modes.reserved.activeDurationMaxMs', '活跃时长上限', 'integer', { section: '活跃与退场', min: 60000, max: 14400000, unit: 'ms' }),
      f('modes.reserved.idleWindowMs', '冷场判定静默窗口', 'integer', { section: '冷场与沉默', min: 10000, max: 3600000, unit: 'ms' }),
      f('modes.reserved.idleRetryProbability', '冷场试探概率', 'number', { section: '冷场与沉默', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.idleRetryWaitMs', '试探后等待回应窗口', 'integer', { section: '冷场与沉默', min: 5000, max: 1800000, unit: 'ms' }),
      f('modes.reserved.skipProbability', '选择性沉默概率', 'number', { section: '冷场与沉默', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.surrenderProbability', '让步退场概率（兼容）', 'number', { section: '冷场与沉默', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.proactiveEnabled', '启用观望期主动开话题', 'boolean', { section: '主动开话题' }),
      f('modes.reserved.proactiveIdleThresholdMs', '群安静门槛', 'integer', { section: '主动开话题', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved.proactiveCheckMinMs', '主动判定最短间隔', 'integer', { section: '主动开话题', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved.proactiveCheckMaxMs', '主动判定最长间隔', 'integer', { section: '主动开话题', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved.proactiveProbability', '主动开口概率', 'number', { section: '主动开话题', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.burstEnabled', '启用分条连发', 'boolean', { section: '连发节奏' }),
      f('modes.reserved.burstIntervalMinMs', '连发最短条间间隔', 'integer', { section: '连发节奏', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved.burstIntervalMaxMs', '连发最长条间间隔', 'integer', { section: '连发节奏', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved.longGapProbability', '长停顿概率', 'number', { section: '连发节奏', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved.longGapMinMs', '长停顿下限', 'integer', { section: '连发节奏', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved.longGapMaxMs', '长停顿上限', 'integer', { section: '连发节奏', min: 0, max: 60000, unit: 'ms' }),
    ],
  },
  {
    id: 'reserved2',
    title: '二代仿真（reserved2）',
    category: '互动模式',
    description: '全面调节二代自主群聊伙伴的唤醒、潜水、沉睡观察、发送限流、等待、主动交互、上下文快照与反馈参数。',
    fields: [
      f('modes.reserved2.enabled', '启用二代仿真', 'boolean', { section: '基础开关' }),
      f('modes.reserved2.agentPreset', '二代 Agent 预设名', 'string', { section: '基础开关' }),
      f('modes.reserved2.provideRecommendations', '向模型提供推荐节奏建议', 'boolean', { section: '基础开关' }),
      f('modes.reserved2.autoReplyCheckMs', '发言后自动检查回复延迟', 'integer', { section: '基础开关', min: 1000, max: 600000, unit: 'ms' }),
      f('modes.reserved2.flushIntervalMs', '状态节流落盘间隔', 'integer', { section: '基础开关', min: 0, max: 60000, unit: 'ms', applyMode: 'restart' }),
      f('modes.reserved2.initialPromptMaxChars', '会话开场说明字数上限', 'integer', { section: '基础开关', min: 100, max: 8000 }),

      f('modes.reserved2.wake.defaultMode', '默认唤醒状态', 'enum', { section: '唤醒与潜水', options: ['diving', 'active'] }),
      f('modes.reserved2.wake.preSleepWaitEnabled', '启用沉睡前强制观察窗口', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.preSleepWaitMs', '沉睡前观察时长', 'integer', { section: '唤醒与潜水', min: 0, max: 1800000, unit: 'ms' }),
      f('modes.reserved2.wake.staleChatMinutes', '聊天消息陈旧门槛', 'integer', { section: '唤醒与潜水', min: 1, max: 1440, unit: '分钟' }),
      f('modes.reserved2.wake.staleSilentMinutes', '静默过久门槛', 'integer', { section: '唤醒与潜水', min: 5, max: 10080, unit: '分钟' }),
      f('modes.reserved2.wake.recommendedDefaultInfinite', '推荐默认无限期潜水', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.sleepMinMs', '允许最短睡眠时长', 'integer', { section: '唤醒与潜水', min: 0, max: 86400000, unit: 'ms' }),
      f('modes.reserved2.wake.sleepMaxMs', '允许最长睡眠时长（0=不限）', 'integer', { section: '唤醒与潜水', min: 0, max: 604800000, unit: 'ms' }),
      f('modes.reserved2.wake.recommendedSleepMinMs', '推荐最短潜水时长', 'integer', { section: '唤醒与潜水', min: 0, max: 86400000, unit: 'ms' }),
      f('modes.reserved2.wake.recommendedSleepMaxMs', '推荐最长潜水时长', 'integer', { section: '唤醒与潜水', min: 0, max: 604800000, unit: 'ms' }),
      f('modes.reserved2.wake.recommendedProbability', '推荐普通消息唤醒概率', 'number', { section: '唤醒与潜水', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved2.wake.recommendedKeywords', '推荐唤醒关键词', 'stringArray', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.recommendedAtMention', '推荐开启 @ 唤醒', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.recommendedNameMention', '推荐开启名字提及唤醒', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.recommendedQuestion', '推荐开启提问唤醒', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.recommendedPoke', '推荐开启拍一拍唤醒', 'boolean', { section: '唤醒与潜水' }),
      f('modes.reserved2.wake.batchWindowMs', '入站消息合批窗口', 'integer', { section: '唤醒与潜水', min: 0, max: 120000, unit: 'ms' }),
      f('modes.reserved2.wake.maxWakePerMinute', '每分钟最大唤醒次数', 'integer', { section: '唤醒与潜水', min: 0, max: 60 }),
      f('modes.reserved2.wake.maxWakePerHour', '每小时最大唤醒次数', 'integer', { section: '唤醒与潜水', min: 0, max: 600 }),
      f('modes.reserved2.wake.noActionLimit', '连续无动作自动防永眠阈值', 'integer', { section: '唤醒与潜水', min: 1, max: 20 }),
      f('modes.reserved2.wake.maxWakeConfigReminders', '单回合收尾提醒上限', 'integer', { section: '唤醒与潜水', min: 0, max: 10 }),
      f('modes.reserved2.wake.recommendedHint', '唤醒建议提示语', 'textarea', { section: '唤醒与潜水' }),

      f('modes.reserved2.send.burstEnabled', '允许分条连发', 'boolean', { section: '发送与限流' }),
      f('modes.reserved2.send.burstMaxMessages', '单次最多连发条数', 'integer', { section: '发送与限流', min: 1, max: 20 }),
      f('modes.reserved2.send.burstIntervalMinMs', '连发最短间隔', 'integer', { section: '发送与限流', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved2.send.burstIntervalMaxMs', '连发最长间隔', 'integer', { section: '发送与限流', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved2.send.longGapProbability', '长停顿概率', 'number', { section: '发送与限流', min: 0, max: 1, step: 0.01 }),
      f('modes.reserved2.send.longGapMinMs', '长停顿下限', 'integer', { section: '发送与限流', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved2.send.longGapMaxMs', '长停顿上限', 'integer', { section: '发送与限流', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved2.send.maxSendPerMinute', '每分钟发送上限（0=不限）', 'integer', { section: '发送与限流', min: 0, max: 120 }),
      f('modes.reserved2.send.maxSendPerHour', '每小时发送上限（0=不限）', 'integer', { section: '发送与限流', min: 0, max: 1200 }),
      f('modes.reserved2.send.maxMessageChars', '单条消息最大字数', 'integer', { section: '发送与限流', min: 20, max: 4000 }),
      f('modes.reserved2.send.maxGapMs', '动态字数间隔上限', 'integer', { section: '发送与限流', min: 0, max: 60000, unit: 'ms' }),
      f('modes.reserved2.send.gapBaseMs', '动态字数间隔基数', 'integer', { section: '发送与限流', min: 0, max: 30000, unit: 'ms' }),
      f('modes.reserved2.send.gapPerCharMs', '每字符增加间隔', 'integer', { section: '发送与限流', min: 0, max: 1000, unit: 'ms' }),
      f('modes.reserved2.send.recommendedHint', '发送节奏建议提示语', 'textarea', { section: '发送与限流' }),

      f('modes.reserved2.wait.defaultMs', '默认等待时长', 'integer', { section: '等待与主动' , min: 1000, max: 600000, unit: 'ms' }),
      f('modes.reserved2.wait.minMs', '最短等待时长', 'integer', { section: '等待与主动', min: 1000, max: 600000, unit: 'ms' }),
      f('modes.reserved2.wait.maxMs', '最长等待时长', 'integer', { section: '等待与主动', min: 1000, max: 1800000, unit: 'ms' }),
      f('modes.reserved2.wait.defaultQuietMs', '默认静默等待', 'integer', { section: '等待与主动', min: 0, max: 120000, unit: 'ms' }),
      f('modes.reserved2.wait.minQuietAfterNewMs', '新消息后最短防抢话静默', 'integer', { section: '等待与主动', min: 0, max: 120000, unit: 'ms' }),
      f('modes.reserved2.proactive.enabled', '启用主动冒泡检查', 'boolean', { section: '等待与主动' }),
      f('modes.reserved2.proactive.checkIntervalMinMs', '主动检查最短间隔', 'integer', { section: '等待与主动', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved2.proactive.checkIntervalMaxMs', '主动检查最长间隔', 'integer', { section: '等待与主动', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved2.proactive.idleThresholdMs', '主动冒泡空闲门槛', 'integer', { section: '等待与主动', min: 60000, max: 86400000, unit: 'ms' }),
      f('modes.reserved2.proactive.probability', '主动冒泡触发概率', 'number', { section: '等待与主动', min: 0, max: 1, step: 0.01 }),

      f('modes.reserved2.context.recentLimit', '内存保留最近消息条数', 'integer', { section: '上下文与反馈', min: 10, max: 500 }),
      f('modes.reserved2.context.unreadLimit', '未读缓冲上限', 'integer', { section: '上下文与反馈', min: 5, max: 200 }),
      f('modes.reserved2.context.contextWindow', '默认上下文窗口', 'integer', { section: '上下文与反馈', min: 1, max: 100 }),
      f('modes.reserved2.context.inlineWakeMessages', '唤醒时内联消息快照', 'boolean', { section: '上下文与反馈' }),
      f('modes.reserved2.context.wakeMessageLimit', '内联未读消息条数上限', 'integer', { section: '上下文与反馈', min: 1, max: 100 }),
      f('modes.reserved2.context.wakeRecentLimit', '内联最近背景条数上限', 'integer', { section: '上下文与反馈', min: 0, max: 20 }),
      f('modes.reserved2.context.wakeMaxChars', '内联快照最大字符数', 'integer', { section: '上下文与反馈', min: 500, max: 20000 }),
      f('modes.reserved2.feedback.maxLength', 'AI 反馈最大字数', 'integer', { section: '上下文与反馈', min: 50, max: 4000 }),
      f('modes.reserved2.feedback.notifyOwnerOnError', '工具异常时通知管理员', 'boolean', { section: '上下文与反馈' }),
    ],
  },
  {
    id: 'media',
    title: '媒体与视觉归一化',
    category: '媒体与工具',
    description: '控制图片下载体积/像素限制、送入模型的压缩分辨率、GIF 抽帧拼图及 FFmpeg 归一化超时。',
    fields: [
      f('modes.reserved2.media.maxBytes', '单图下载最大字节数', 'integer', { section: '入站限制', min: 65536, max: 52428800, unit: 'bytes' }),
      f('modes.reserved2.media.maxPixels', '单图最大像素总数', 'integer', { section: '入站限制', min: 10000, max: 200000000, unit: 'px' }),
      f('modes.reserved2.media.maxCount', '单次最多读取图片数', 'integer', { section: '入站限制', min: 1, max: 20 }),
      f('modes.reserved2.media.normalize', '启用图片尺寸与体积归一化', 'boolean', { section: '模型归一化' }),
      f('modes.reserved2.media.maxModelBytes', '送入模型单图体积目标', 'integer', { section: '模型归一化', min: 65536, max: 3145728, unit: 'bytes' }),
      f('modes.reserved2.media.maxLongEdge', '送入模型最大长边', 'integer', { section: '模型归一化', min: 256, max: 4096, unit: 'px' }),
      f('modes.reserved2.media.gifFrames', 'GIF 抽帧数量', 'integer', { section: '动图处理', min: 1, max: 16 }),
      f('modes.reserved2.media.gifTile', 'GIF 拼图单格边长', 'integer', { section: '动图处理', min: 64, max: 1024, unit: 'px' }),
      f('modes.reserved2.media.normalizeTimeoutMs', '图片归一化超时', 'integer', { section: '动图处理', min: 3000, max: 120000, unit: 'ms' }),
    ],
  },
  {
    id: 'sticker-voice',
    title: '表情、语音与工具权限',
    category: '媒体与工具',
    description: '调节收藏表情缓存/收藏限流、语音发送音量与限流，以及全部 29 项 AI 工具开关。',
    fields: [
      f('modes.reserved2.sticker.enabled', '启用表情功能', 'boolean', { section: '表情参数' }),
      f('modes.reserved2.sticker.syncTtlMs', '表情库同步缓存 TTL', 'integer', { section: '表情参数', min: 5000, max: 3600000, unit: 'ms' }),
      f('modes.reserved2.sticker.maxListCount', '单次列表最多返回表情数', 'integer', { section: '表情参数', min: 1, max: 500 }),
      f('modes.reserved2.sticker.includeInPrompt', '在唤醒提示中附带常用表情摘要', 'boolean', { section: '表情参数' }),
      f('modes.reserved2.sticker.promptMaxStickers', '提示词表情摘要上限', 'integer', { section: '表情参数', min: 1, max: 30 }),
      f('modes.reserved2.sticker.collect.enabled', '允许 AI 收藏群友表情', 'boolean', { section: '表情收藏限流' }),
      f('modes.reserved2.sticker.collect.maxPerMinute', '每分钟最多收藏次数', 'integer', { section: '表情收藏限流', min: 0, max: 60 }),
      f('modes.reserved2.sticker.collect.maxPerHour', '每小时最多收藏次数', 'integer', { section: '表情收藏限流', min: 0, max: 300 }),
      f('modes.reserved2.sticker.collect.maxRemarkChars', '收藏备注最大字数', 'integer', { section: '表情收藏限流', min: 1, max: 100 }),

      f('modes.reserved2.voice.enabled', '允许发送本地语音条', 'boolean', { section: '语音参数' }),
      f('modes.reserved2.voice.maxSeconds', '单条语音最大时长', 'integer', { section: '语音参数', min: 1, max: 600, unit: '秒' }),
      f('modes.reserved2.voice.maxBytes', '单条语音最大体积', 'integer', { section: '语音参数', min: 10240, max: 52428800, unit: 'bytes' }),
      f('modes.reserved2.voice.maxPerMinute', '每分钟最多发语音条数', 'integer', { section: '语音参数', min: 0, max: 30 }),
      f('modes.reserved2.voice.maxPerHour', '每小时最多发语音条数', 'integer', { section: '语音参数', min: 0, max: 200 }),
      f('modes.reserved2.voice.defaultVolume', '默认音量倍率', 'number', { section: '语音参数', min: 0.1, max: 4, step: 0.1 }),
      f('modes.reserved2.voice.loudness', '响度风格预设', 'enum', { section: '语音参数', options: ['soft', 'normal', 'loud'] }),
      f('modes.reserved2.voice.autoReadback', '发送后自动回读语音状态', 'boolean', { section: '语音参数' }),
      f('modes.reserved2.voice.dir', '语音库目录', 'string', { section: '语音本机只读项', sensitivity: 'localOnly', description: '仅可在部署机 config.json 修改' }),
      f('modes.reserved2.voice.ffmpegPath', 'FFmpeg 可执行路径', 'string', { section: '语音本机只读项', sensitivity: 'localOnly', description: '仅可在部署机 config.json 或 FFMPEG_PATH 修改' }),
      f('modes.reserved2.voice.allowAbsolutePath', '允许绝对路径（仅操作者）', 'boolean', { section: '语音本机只读项', sensitivity: 'localOnly', description: '仅可在部署机 config.json 修改' }),

      ...TOOL_FIELDS,
    ],
  },
  {
    id: 'role',
    title: '角色卡与提示词注入',
    category: '人格与记忆',
    description: '控制角色卡注入字数上限、每 N 轮完整注入节奏以及短时间重复构建去重窗口。',
    fields: [
      f('role.maxInjectChars', '角色卡注入最大字符数', 'integer', { section: '注入策略', min: 200, max: 50000, description: '超出上限时按规则裁剪' }),
      f('role.injectEveryNWakes', '每 N 次唤醒完整注入一次角色卡', 'integer', { section: '注入策略', min: 0, max: 50, description: '0 或 1 表示每次唤醒都完整注入' }),
      f('role.injectDedupeWindowMs', '角色注入去重时间窗', 'integer', { section: '注入策略', min: 0, max: 120000, unit: 'ms', description: '窗口内重复构建沿用上次判定；0 关闭' }),
    ],
  },
  {
    id: 'memory-identity',
    title: '记忆、词汇、归档与身份',
    category: '人格与记忆',
    description: '管理长期记忆压缩、消息归档保留期与分片体积、词汇学习以及群友身份称呼与 QQ 脱敏策略。',
    fields: [
      f('memory.enabled', '启用长期记忆压缩', 'boolean', { section: '长期记忆', applyMode: 'restart', description: '需同时开启消息归档；整理时会额外调用模型' }),
      f('memory.learnerPreset', '记忆整理 Agent 预设', 'string', { section: '长期记忆', applyMode: 'restart' }),
      f('memory.workspaceTitle', '记忆整理工作区标题', 'string', { section: '长期记忆', applyMode: 'restart' }),
      f('memory.terms.enabled', '启用词汇记忆', 'boolean', { section: '词汇记忆', applyMode: 'restart' }),
      f('memory.terms.injectMax', '单次注入提示词的最大词条数', 'integer', { section: '词汇记忆', min: 1, max: 30, applyMode: 'hot' }),
      f('memory.terms.maxPerConv', '单会话最大词条容量', 'integer', { section: '词汇记忆', min: 10, max: 2000, applyMode: 'hot' }),
      f('memory.archive.enabled', '启用本机消息归档', 'boolean', { section: '消息归档', applyMode: 'restart', description: '关闭后不写入原文归档' }),
      f('memory.archive.retentionDays', '归档保留天数（0=永久）', 'integer', { section: '消息归档', min: 0, max: 3650, unit: '天', applyMode: 'restart' }),
      f('memory.archive.maxShardMb', '单个归档分片体积上限', 'integer', { section: '消息归档', min: 1, max: 1024, unit: 'MB', applyMode: 'restart' }),
      f('identity.enabled', '启用群友身份与称呼体系', 'boolean', { section: '身份与隐私', applyMode: 'hot' }),
      f('identity.learnFromChat', '从群聊自动学习称呼候选', 'boolean', { section: '身份与隐私', applyMode: 'hot' }),
      f('identity.renderAliasTableMax', '花名册单次展示最大成员数', 'integer', { section: '身份与隐私', min: 1, max: 200, applyMode: 'hot' }),
      f('identity.exposeQqInPrompt', '在提示词与工具中暴露明文 QQ 号', 'boolean', { section: '身份与隐私', applyMode: 'hot', description: '默认关闭（使用 member-* 与群内称呼代替）' }),
    ],
  },
  {
    id: 'search-pricing-security',
    title: '联网搜索、计费价目与安全',
    category: '扩展与安全',
    description: '调节联网搜索后端与超时、自定义模型费用价目覆盖，以及出站拦截通知策略。',
    fields: [
      f('webSearch.provider', '搜索引擎选择', 'enum', { section: '联网搜索', options: ['auto', 'deepseek', 'bing'], applyMode: 'hot', description: 'auto 优先 DeepSeek，失败回退 Bing' }),
      f('webSearch.model', 'DeepSeek 搜索模型', 'string', { section: '联网搜索', applyMode: 'hot' }),
      f('webSearch.baseURL', '自定义搜索 API Base URL', 'string', { section: '联网搜索', applyMode: 'hot', description: '留空使用官方默认地址' }),
      f('webSearch.apiKeyEnv', '搜索 API Key 环境变量名', 'string', { section: '联网搜索', applyMode: 'hot' }),
      f('webSearch.apiKey', 'DeepSeek 搜索 API Key', 'string', { section: '联网搜索', sensitivity: 'secret', applyMode: 'hot', description: '留空不改；仅写入不回显明文' }),
      f('webSearch.maxUses', '单次最大搜索步数', 'integer', { section: '联网搜索', min: 1, max: 20, applyMode: 'hot' }),
      f('webSearch.maxTokens', '搜索响应最大 Token', 'integer', { section: '联网搜索', min: 256, max: 32768, applyMode: 'hot' }),
      f('webSearch.maxResults', '返回结果条数上限', 'integer', { section: '联网搜索', min: 1, max: 30, applyMode: 'hot' }),
      f('webSearch.timeoutMs', '搜索请求总超时', 'integer', { section: '联网搜索', min: 3000, max: 120000, unit: 'ms', applyMode: 'hot' }),
      f('pricing', '模型计费价目覆写 (JSON)', 'json', { section: '计费价目', applyMode: 'hot', description: '填 null 使用内置价目表；或填 { symbol, peakMultiplier, models: { ... } }' }),
      f('security.interceptNotify', '出站敏感拦截时私信提醒管理员', 'boolean', { section: '安全通知', applyMode: 'hot' }),
    ],
  },
]);

export const MODULE_MAP = new Map(MODULE_DEFINITIONS.map((m) => [m.id, m]));

function getByPath(obj, dotPath) {
  let cur = obj;
  for (const part of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainConfigObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteByPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainConfigObject(cur[parts[i]])) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

// 将规范 config.json 路径映射到运行态 b.cfg 路径（b.cfg 仍沿用 social / socialV2 / archive 内部键）
function runningPathFor(canonicalPath) {
  if (canonicalPath.startsWith('modes.reserved.')) return `social.${canonicalPath.slice('modes.reserved.'.length)}`;
  if (canonicalPath.startsWith('modes.reserved2.')) return `socialV2.${canonicalPath.slice('modes.reserved2.'.length)}`;
  if (canonicalPath.startsWith('memory.archive.')) return `archive.${canonicalPath.slice('memory.archive.'.length)}`;
  return canonicalPath;
}

function stableEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 构造前端展示的 14 模块完整目录（附运行值、磁盘配置值、是否待重启、脱敏态） */
export function buildModuleCatalog({ cfg, fileConfig, configFile = 'config.json' }) {
  const migratedFile = migrateLegacyConfig(fileConfig ?? {}).config;
  let effectiveDiskCfg = cfg;
  try {
    effectiveDiskCfg = loadConfig({ configFile, readJsonSafe: () => migratedFile, discoverDshLaunchToken: () => '' });
  } catch {}
  let pendingRestartCount = 0;
  const modules = MODULE_DEFINITIONS.map((mod) => {
    const fields = mod.fields.map((field) => {
      const runPath = runningPathFor(field.path);
      const rawRun = getByPath(cfg, runPath);
      const rawDisk = getByPath(effectiveDiskCfg, runPath);
      if (field.sensitivity === 'secret') {
        const diskSecret = getByPath(migratedFile, field.path);
        const configured = Boolean(String(diskSecret ?? '').trim());
        const runningConfigured = Boolean(String(rawRun ?? '').trim());
        const pendingRestart = field.applyMode === 'restart' && configured !== runningConfigured;
        if (pendingRestart) pendingRestartCount += 1;
        return { ...field, running: { configured: runningConfigured }, configured: { configured }, pendingRestart };
      }
      const pendingRestart = field.applyMode === 'restart' && !stableEqual(rawRun, rawDisk);
      if (pendingRestart) pendingRestartCount += 1;
      return {
        ...field,
        running: rawRun === undefined ? null : structuredClone(rawRun),
        configured: rawDisk === undefined ? null : structuredClone(rawDisk),
        pendingRestart,
      };
    });
    return {
      id: mod.id,
      title: mod.title,
      category: mod.category,
      description: mod.description,
      pendingRestartCount: fields.filter((x) => x.pendingRestart).length,
      fields,
    };
  });
  return { modules, pendingRestartCount };
}

function coerceFieldValue(field, raw) {
  if (field.sensitivity === 'localOnly') {
    throw Object.assign(new Error(`参数 ${field.path} 仅可在部署机 config.json 中修改`), { statusCode: 400 });
  }
  switch (field.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') throw Object.assign(new Error(`${field.path} 必须是布尔值`), { statusCode: 400 });
      return raw;
    case 'integer': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw Object.assign(new Error(`${field.path} 必须是整数`), { statusCode: 400 });
      if (field.min !== undefined && n < field.min) throw Object.assign(new Error(`${field.path} 不能小于 ${field.min}`), { statusCode: 400 });
      if (field.max !== undefined && n > field.max) throw Object.assign(new Error(`${field.path} 不能大于 ${field.max}`), { statusCode: 400 });
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw Object.assign(new Error(`${field.path} 必须是有效数字`), { statusCode: 400 });
      if (field.min !== undefined && n < field.min) throw Object.assign(new Error(`${field.path} 不能小于 ${field.min}`), { statusCode: 400 });
      if (field.max !== undefined && n > field.max) throw Object.assign(new Error(`${field.path} 不能大于 ${field.max}`), { statusCode: 400 });
      return n;
    }
    case 'string':
    case 'textarea': {
      const s = String(raw ?? '');
      if (field.path === 'dsh.reasoningEffort') return normalizeReasoningEffort(s);
      return field.type === 'textarea' ? s : s.trim();
    }
    case 'enum': {
      const s = String(raw ?? '').trim();
      if (field.path === 'dsh.reasoningEffort') return normalizeReasoningEffort(s);
      if (!field.options.includes(s)) throw Object.assign(new Error(`${field.path} 必须是 ${field.options.join(' / ')} 之一`), { statusCode: 400 });
      return s;
    }
    case 'optionalEnum': {
      const s = String(raw ?? '').trim();
      if (!s) return undefined;
      if (!field.options.includes(s)) throw Object.assign(new Error(`${field.path} 必须是 ${field.options.filter(Boolean).join(' / ')} 或留空`), { statusCode: 400 });
      return s;
    }
    case 'stringArray': {
      const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\r\n,，]+/);
      return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
    case 'qqList': {
      const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\r\n,，\s]+/).filter(Boolean);
      return [...new Set(normalizeIdList(arr).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    }
    case 'nullableQq': {
      if (raw === null || raw === '' || raw === undefined) return null;
      return normalizeOwnerQQ(raw);
    }
    case 'json': {
      if (raw === null || raw === '') return null;
      const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (val !== null && (typeof val !== 'object' || Array.isArray(val))) {
        throw Object.assign(new Error(`${field.path} 必须是 JSON 对象或 null`), { statusCode: 400 });
      }
      return val;
    }
    default:
      return raw;
  }
}

/** 校验并生成某模块更新后的完整配置候选（不直接写盘） */
export function validateModulePatch({ moduleId, values = {}, resetDefaults = false, currentFile, configFile = 'config.json' }) {
  const mod = MODULE_MAP.get(moduleId);
  if (!mod) throw Object.assign(new Error(`未知模块：${moduleId}`), { statusCode: 404 });
  const fieldByPath = new Map(mod.fields.map((x) => [x.path, x]));
  const nextFile = structuredClone(migrateLegacyConfig(currentFile ?? {}).config);
  const changedPaths = [];
  const hotPaths = [];
  let requiresRestart = false;

  if (resetDefaults === true) {
    for (const field of mod.fields) {
      if (field.sensitivity === 'localOnly' || field.sensitivity === 'secret') continue;
      deleteByPath(nextFile, field.path);
      changedPaths.push(field.path);
      if (field.applyMode === 'restart') requiresRestart = true;
      else hotPaths.push(field.path);
    }
  } else {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw Object.assign(new Error('values 必须是键值对象'), { statusCode: 400 });
    }
    for (const [dotPath, rawValue] of Object.entries(values)) {
      const field = fieldByPath.get(dotPath);
      if (!field) throw Object.assign(new Error(`模块 ${moduleId} 不包含参数：${dotPath}`), { statusCode: 400 });
      // secret 字段：传空字符串或 undefined 视为不修改；传 null 显式清空
      if (field.sensitivity === 'secret') {
        if (rawValue === undefined || rawValue === '') continue;
        const nextSecret = rawValue === null ? '' : String(rawValue).trim();
        setByPath(nextFile, dotPath, nextSecret);
        changedPaths.push(dotPath);
        if (field.applyMode === 'restart') requiresRestart = true;
        else hotPaths.push(dotPath);
        continue;
      }
      const coerced = coerceFieldValue(field, rawValue);
      if (coerced === undefined) deleteByPath(nextFile, dotPath);
      else setByPath(nextFile, dotPath, coerced);
      changedPaths.push(dotPath);
      if (field.applyMode === 'restart') requiresRestart = true;
      else hotPaths.push(dotPath);
    }
  }

  // 范围成对校验（min <= max 自动归一化）
  const minMaxPairs = [
    ['modes.reserved.activeCheckMinMs', 'modes.reserved.activeCheckMaxMs'],
    ['modes.reserved.activeReplyDelayMinMs', 'modes.reserved.activeReplyDelayMaxMs'],
    ['modes.reserved.activeDurationMinMs', 'modes.reserved.activeDurationMaxMs'],
    ['modes.reserved.proactiveCheckMinMs', 'modes.reserved.proactiveCheckMaxMs'],
    ['modes.reserved.burstIntervalMinMs', 'modes.reserved.burstIntervalMaxMs'],
    ['modes.reserved.longGapMinMs', 'modes.reserved.longGapMaxMs'],
    ['modes.reserved2.send.burstIntervalMinMs', 'modes.reserved2.send.burstIntervalMaxMs'],
    ['modes.reserved2.send.longGapMinMs', 'modes.reserved2.send.longGapMaxMs'],
    ['modes.reserved2.wait.minMs', 'modes.reserved2.wait.maxMs'],
    ['modes.reserved2.proactive.checkIntervalMinMs', 'modes.reserved2.proactive.checkIntervalMaxMs'],
  ];
  for (const [minP, maxP] of minMaxPairs) {
    const a = getByPath(nextFile, minP);
    const b = getByPath(nextFile, maxP);
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) {
      setByPath(nextFile, minP, b);
      setByPath(nextFile, maxP, a);
    }
  }

  // 通过真实 loadConfig 做全量启动级校验
  let validatedCfg;
  try {
    validatedCfg = loadConfig({ configFile, readJsonSafe: () => nextFile, discoverDshLaunchToken: () => '' });
  } catch (error) {
    throw Object.assign(new Error(`配置校验失败：${error?.message ?? error}`), { statusCode: 400 });
  }

  return { mod, moduleId: mod.id, nextFile, validatedCfg, changedPaths, hotPaths, requiresRestart };
}

/** 将已校验的配置热更新到运行态 b.cfg 并触发模块级钩子 */
export function applyHotModuleChanges(b, { moduleId, mod, validatedCfg, hotPaths }) {
  const targetModuleId = moduleId ?? mod?.id;
  if (!hotPaths.length) return;
  const setRun = (dotPath) => {
    const runPath = runningPathFor(dotPath);
    const val = getByPath(validatedCfg, runPath);
    setByPath(b.cfg, runPath, val === undefined ? undefined : structuredClone(val));
  };
  for (const p of hotPaths) setRun(p);

  if (targetModuleId === 'gate' || hotPaths.includes('allowAllWhenEmpty')) {
    b.reconcileSessionPolicies?.();
  }
  if (targetModuleId === 'dsh' && hotPaths.some((p) => ['dsh.provider', 'dsh.model', 'dsh.reasoningEffort'].includes(p))) {
    b.modelSelectionEpoch = (b.modelSelectionEpoch ?? 0) + 1;
  }
  if (targetModuleId === 'backend-agy') {
    const backendType = b.cfg.backend?.type === 'gemini' ? 'gemini' : 'agy';
    b.api?.updateConfig?.(b.cfg.backend?.[backendType] ?? b.cfg.backend?.agy);
    if (hotPaths.includes('backend.agy.model') || hotPaths.includes('backend.gemini.model')) {
      b.modelSelectionEpoch = (b.modelSelectionEpoch ?? 0) + 1;
    }
    if (hotPaths.some((p) => p === 'backend.agy.permissions.allow' || p === 'backend.agy.permissions.deny')) {
      b.modelSelectionEpoch = (b.modelSelectionEpoch ?? 0) + 1;
      b.api?.onPermissionsChanged?.();
    }
  }
  if (targetModuleId === 'modular-broker') {
    b.api?.updateBrokerConfig?.(b.cfg.broker);
  }
  if (targetModuleId === 'role' && hotPaths.includes('role.maxInjectChars') && typeof b.applyRoleInjectLimit === 'function') {
    b.roleInjectMaxChars = b.applyRoleInjectLimit(validatedCfg.role?.maxInjectChars);
  }
  if (targetModuleId === 'reserved2' || targetModuleId === 'media' || targetModuleId === 'sticker-voice') {
    b.cfg.socialV2 = deepMergePlain(b.cfg.socialV2 ?? {}, validatedCfg.socialV2 ?? {});
    if (targetModuleId === 'reserved2' && hotPaths.some((p) => p.startsWith('modes.reserved2.wake.'))) {
      for (const [k, st] of b.socialV2?.conversations?.entries?.() ?? []) {
        if (st && st.wakeConfig?.isDefault) {
          st.wakeConfig = b.defaultWakeConfigV2();
          b.setupSleepTimerV2?.(k);
        }
      }
    }
  }
  if (targetModuleId === 'search-pricing-security') {
    b.clearSearchCache?.();
  }
}
