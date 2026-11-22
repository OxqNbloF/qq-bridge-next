// 二代工具开关单一事实来源（默认值、开关清单、提示词名称映射），桥接与 MCP server 共用

/** 缺省开关；新增时同步 MCP 的 TOOL_CONFIG_FLAGS */
export const DEFAULT_SOCIAL_V2_TOOLS = Object.freeze({
  getPrompt: true,
  getUnread: true,
  getRecent: true,
  socialState: true,
  sendGroup: true,
  sendPrivate: true,
  reply: true,
  sendBurst: true,
  sendMessage: true,
  waitMessages: true,
  feedback: true,
  getMyRecent: true,
  getMessageDetail: true,
  getActiveMembers: true,
  getGroupMembers: true,
  setWakeConfig: true,
  markRead: true,
  memory: true,
  getImages: true,
  getForwardMsg: true,
  sendPoke: true,
  listStickers: true,
  getStickerImage: true,
  sendSticker: true,
  setStickerRemark: false,
  stickerNote: true,
  collectSticker: true,
  getSelfImage: true,
  sendVoice: false,
});

/** 所有已知工具开关键名（自动从默认表推导，不再多处手写漂移） */
export const SOCIAL_V2_TOOL_FLAGS = Object.freeze(Object.keys(DEFAULT_SOCIAL_V2_TOOLS));

/** 表情类工具开关（受 sticker.enabled 总闸联动） */
export const STICKER_TOOL_FLAGS = Object.freeze([
  'listStickers',
  'getStickerImage',
  'sendSticker',
  'setStickerRemark',
  'stickerNote',
  'collectSticker',
]);

/** 语音类工具开关（受 voice.enabled 总闸联动） */
export const VOICE_TOOL_FLAGS = Object.freeze(['sendVoice']);

/** 工具开关 → 提示词 / qq_get_prompt 展示名 */
export const SOCIAL_V2_TOOL_PROMPT_MAP = Object.freeze({
  getPrompt: 'qq_get_prompt',
  getUnread: 'qq_get_unread_messages',
  getRecent: 'qq_get_recent_messages',
  socialState: 'qq_social_state',
  sendGroup: 'qq_send_group_message',
  sendPrivate: 'qq_send_private_message',
  reply: 'qq_reply',
  sendBurst: 'qq_send_burst',
  sendMessage: 'qq_send_message',
  waitMessages: 'qq_wait_for_messages',
  feedback: 'qq_report_feedback',
  getMyRecent: 'qq_get_my_recent_messages',
  getMessageDetail: 'qq_get_message_detail',
  getActiveMembers: 'qq_get_active_members',
  getGroupMembers: 'qq_get_group_members',
  setWakeConfig: 'qq_set_wake_config',
  markRead: 'qq_mark_read',
  memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
  getImages: 'qq_get_message_images',
  getForwardMsg: 'qq_get_forward_msg',
  sendPoke: 'qq_send_poke',
  listStickers: 'qq_list_stickers',
  getStickerImage: 'qq_get_sticker_image',
  sendSticker: 'qq_send_sticker',
  setStickerRemark: 'qq_set_sticker_remark',
  stickerNote: 'qq_sticker_note',
  collectSticker: 'qq_collect_sticker',
  getSelfImage: 'qq_get_self_image',
  sendVoice: 'qq_send_voice / qq_list_voices',
});

/** 与默认值浅合并，非对象输入视为未配置 */
export function resolveSocialV2Tools(configured) {
  const own = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  const next = { ...DEFAULT_SOCIAL_V2_TOOLS, ...own };
  delete next.slangQuery;
  delete next.slangSubmit;
  return next;
}
