export function compareRequests(a, b) {
  return b.request.priority - a.request.priority || a.request.trigger.seq - b.request.trigger.seq || a.order - b.order;
}

export function rateDelay(times, rate, now) {
  return [[60000, rate?.perMinute], [3600000, rate?.perHour]].reduce((delay, [window, limit]) => {
    if (!(limit > 0)) return delay;
    const recent = times.filter((time) => now - time < window).sort((a, b) => a - b);
    return recent.length < limit ? delay : Math.max(delay, recent[recent.length - Math.floor(limit)] + window - now);
  }, 0);
}
