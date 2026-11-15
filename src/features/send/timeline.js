// 分条发送：按空格分句、条间随机间隔、二代 gap
import { planOutboundTimeline } from '../../outbound/validation.js';

// 创建分条发送函数，b 为桥接访问器
export function createSendTimeline(b) {
  // AI 用空格表示分条，单条超 maxReplyChars 再硬拆
  function planSocialTimeline(text, socialCfg) {
    // Compatibility preview only; Outbound re-plans from raw text at execution.
    const preview = planOutboundTimeline(b, text, socialCfg);
    Object.defineProperty(preview.main, 'outboundText', { value: String(text ?? '') });
    return preview;
  }

  // 按顺序逐条发送，条间随机间隔，末条后不等
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
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

    const nextDelay = () => {
      const useLong = longProb > 0 && Math.random() < longProb;
      return useLong ? b.randInt(longMin, longMax) : b.randInt(min, max);
    };
    return b.enqueueOutbound(key, { ai: true, channel: 'timeline', split: 'timeline', timelineText: messages.outboundText,
      nextTimelineDelay: nextDelay,
      batch: messages.map((message, i) => ({
        text: String(message ?? ''),
        afterDelay: i < messages.length - 1 ? nextDelay() : 0,
      })),
    }).then(result => result.sent).catch(error => {
      b.log(`QQ 发送失败 (${key}):`, error?.message ?? error);
      return error.sent ?? [];
    });
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
