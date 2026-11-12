// 二代工具开关默认值，桥接与 MCP server 共用

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
  setWakeConfig: true,
  markRead: true,
  memory: true,
  slangQuery: true,
  slangSubmit: true,
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

/** 与默认值浅合并，非对象输入视为未配置 */
export function resolveSocialV2Tools(configured) {
  const own = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  return { ...DEFAULT_SOCIAL_V2_TOOLS, ...own };
}
