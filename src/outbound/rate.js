import { outboundError } from './validation.js';

// The rollout-wide lane and legacy tool ledger are distinct existing budgets.
// Reserve both atomically, never charge the legacy ledger twice for media whose
// capability already manages it. Pending reservations survive long burst gaps.
export function createOutboundRate(b, sendTimes, key, intent) {
  const lanes = [];
  if (intent.ai) {
    const ensureAiTimes = () => {
      const recent = (sendTimes.get(key) ?? []).filter(at => Date.now() - at < 3600000);
      sendTimes.set(key, recent);
      return recent;
    };
    ensureAiTimes();
    lanes.push({ getTimes: ensureAiTimes, pending: 0 });
  }
  if (intent.rateScope === 'tool') {
    lanes.push({
      getTimes: () => {
        const list = b.getSocialV2State(key).sendTimes;
        const cutoff = Date.now() - 3600000;
        let prune = 0;
        while (prune < list.length && list[prune] <= cutoff) prune += 1;
        if (prune > 0) list.splice(0, prune);
        return list;
      },
      pending: 0,
    });
  }
  function check(count = 0) {
    const cfg = b.cfg.socialV2?.send ?? {}, now = Date.now();
    for (const lane of lanes) {
      const times = lane.getTimes();
      const used = ms => times.filter(at => now - at < ms).length + lane.pending;
      if ((cfg.maxSendPerMinute > 0 && used(60000) + count > cfg.maxSendPerMinute)
        || (cfg.maxSendPerHour > 0 && used(3600000) + count > cfg.maxSendPerHour)) {
        throw outboundError('发送频率超限，请稍后再试', 429);
      }
    }
  }
  function reserve(count) {
    check(count);
    for (const lane of lanes) lane.pending += count;
  }
  function release(count) {
    for (const lane of lanes) lane.pending = Math.max(0, lane.pending - count);
  }
  function commit() {
    const now = Date.now();
    for (const lane of lanes) {
      if (lane.pending > 0) lane.pending -= 1;
      const times = lane.getTimes();
      times.push(now);
      if (times.length > 500) times.splice(0, times.length - 500);
    }
  }
  function rollback() {
    for (const lane of lanes) {
      lane.pending = 0;
      const times = lane.getTimes();
      if (times.length > 500) times.splice(0, times.length - 500);
    }
  }
  return { check, reserve, release, commit, rollback };
}
