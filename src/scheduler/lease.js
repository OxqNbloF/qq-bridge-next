export function createLease(turnId, now, duration, conv, kind) {
  return { conv, kind, turnId, startedAt: now, lastEventAt: now, expiresAt: now + duration, sessionId: null, transportTurn: null, toolCallAt: 0, pendingToolCalls: [] };
}
