import { SENSITIVE_RE } from '../sensitive.js';

// Content audit is called only after gate and rate reservation.
export function assertOutboundPolicy(b, key, intent) {
  if ((intent.channel === 'tool' || (intent.ai && b.shouldAuditKey(key))) && SENSITIVE_RE.test(intent.text ?? intent.archiveText ?? '')) throw Object.assign(new Error('消息含敏感信息，已阻止发送'), { statusCode: 403, code: 'OUTBOUND_AUDIT' });
  if (b.hasKnownTokenFragment(intent.text ?? intent.archiveText ?? '')) throw Object.assign(new Error('发送内容包含会话令牌，已阻止发送'), { statusCode: 403, code: 'OUTBOUND_AUDIT' });
}

export function assertOutboundMode(b, key, intent) {
  const mode = b.modeForKey(key);
  const adapter = b.modeAdapterForKey(key);
  // tools-only 约束模型输出，不禁止明确的桥接系统通知或操作者发送；不依赖调度灰度开关。
  const systemNotice = !intent.ai && ['system', 'console'].includes(intent.channel);
  if (intent.channel !== 'tool' && !systemNotice && adapter.sendPolicy.mode === 'tools-only') throw new Error('当前模式只允许工具发送');
  if (!intent.ai) return;
  const engine = b.cfg.modes?.engine?.[mode] === true;
  if (intent.channel === 'tool') {
    const voice = intent.segments?.some((segment) => segment.type === 'record');
    const group = intent.action ? 'send' : intent.segments ? (voice ? 'voice' : 'sticker') : intent.group ?? 'send';
    const tool = intent.action ? 'sendPoke' : intent.segments ? (voice ? 'sendVoice' : 'sendSticker') : intent.tool;
    if (engine && (!tool || !adapter.toolPolicy.groups.includes(group) || adapter.toolPolicy.deny.includes(tool))) throw new Error('当前模式不允许该发送工具');
    if (tool && !b.v2ToolEnabled(tool)) throw new Error(`工具未启用：${tool}`);
  }
}
