// 黑话待学习消息窗口与提交限频
import { truncateText } from '../../md-to-plain.js';

// 创建黑话窗口函数，b 为桥接访问器
export function createSlangWindow(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const slangWindows = new Map();       // key -> [{sender,text,time}] 待学习消息
  const slangExtractionCooldowns = new Map(); // key -> 上次抽取时间
  const slangSubmitTimes = new Map();   // key -> [时间戳]，AI 提交候选限频
  // 窗口够大且冷却结束时排队抽取黑话
  function maybeQueueSlangExtraction(key) {
    if (b.cfg.slang?.enabled === false) return;
    if (!b.dshReady) return;
    const cooldown = Number(b.cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(b.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    b.queueSlangTask(() => b.runSlangExtraction(key));
  }

  // 群聊普通消息进窗口；不学命令和引用原文
  function feedSlangWindow(key, sender, plainContent) {
    if (b.cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // 限制单会话短时间内提交的黑话候选数
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  return {
    slangWindows, slangExtractionCooldowns, slangSubmitTimes, maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit };
}
