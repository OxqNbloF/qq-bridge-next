export function buildMessagePrompt(ctx) {
  return (ctx.roleHint ? ctx.roleHint + '\n\n' : '')
    + (ctx.roster ? `【群成员】\n${ctx.roster}\n\n` : '')
    + (ctx.isOwner ? '【管理员】' : '')
    + (ctx.kind === 'group' ? `${ctx.sender}：${ctx.text}` : ctx.text)
    + ctx.mediaHint;
}
