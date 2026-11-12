// 分条发送：按空格分句、条间随机间隔、二代 gap
import { escapeCqText } from '../../policy/audit.js';

// 创建分条发送函数，b 为桥接访问器
export function createSendTimeline(b) {
  // AI 用空格表示分条，单条超 maxReplyChars 再硬拆
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条发送，只做安全硬拆
    if (!enabled) {
      return { main: b.splitLongSegment(src, maxChars).map(b.singleLineForQQ), followUp: null };
    }

    // 按空格拆条，每条再按 maxChars 硬拆
    const parts = b.splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: b.splitLongSegment(parts[0] || src, maxChars).map(b.singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...b.splitLongSegment(part, maxChars).map(b.singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 按顺序逐条发送，条间随机间隔，末条后不等
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    let sendChain = b.sendChainFor(key);
    const assertSendAllowed = b.captureSendGuard(key, { ai: true });
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = b.redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          const result = kind === 'private'
            ? await b.withTimeout(b.bot.sendPrivateMessage(Number(id), b.text(escapeCqText(msg))), b.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`)
            : await b.withTimeout(b.bot.sendGroupMessage(Number(id), b.text(escapeCqText(msg))), b.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          b.archiveOutgoing(key, msg, result);
          sent.push(msg);
        })
        .catch((error) => {
          b.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 记失败，否则调用方会误当已回复而静默丢消息
          b.lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? b.randInt(longMin, longMax) : b.randInt(min, max);
        sendChain = sendChain.then(() => b.sleep(delay));
      }
    }
    return b.rememberSendChain(key, sendChain).then(() => sent);
  }



  // 把间隔限制在配置的最小/最大值之间
  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  // 按 gapMode 计算各条之间的等待毫秒数
  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(b.randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  return { planSocialTimeline, sendBurstToQQ, clampGapV2, computeGapsV2 };
}
