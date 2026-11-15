import { chatMode } from './chat.js';
import { closedAgentMode } from './closed-agent.js';
import { reservedMode } from './reserved.js';
import { reserved2Mode } from './reserved2.js';

export const modeAdapters = Object.freeze({ chat: chatMode, 'closed-agent': closedAgentMode, reserved: reservedMode, reserved2: reserved2Mode });
export function getModeAdapter(id) { return Object.hasOwn(modeAdapters, id) ? modeAdapters[id] : null; }
