import type { WebSocket } from "ws";

const MAX_PAIR_ATTEMPTS = 5;

export interface AgentRecord {
  ws: WebSocket | null; // null while offline -- the record itself persists
  pinHash: string;
  controllerWs: WebSocket | null;
  failedAttempts: number;
  online: boolean;
}

export interface DeviceInfo {
  deviceId: string;
  online: boolean;
}

// In-memory only -- fine for a personal, single-user relay. Restarting the
// signaling server drops the whole device roster, which is an acceptable
// trade-off for the free-tier setup described in the plan.
const agents = new Map<string, AgentRecord>();

// Controllers that asked for the device list, so we know who to push
// "device-status-changed" updates to as agents come and go.
const subscribedControllers = new Set<WebSocket>();

export function registerAgent(deviceId: string, ws: WebSocket, pinHash: string): void {
  agents.set(deviceId, { ws, pinHash, controllerWs: null, failedAttempts: 0, online: true });
}

export function getAgent(deviceId: string): AgentRecord | undefined {
  return agents.get(deviceId);
}

export function listDevices(): DeviceInfo[] {
  return [...agents.entries()].map(([deviceId, agent]) => ({ deviceId, online: agent.online }));
}

export function subscribeToDeviceList(ws: WebSocket): void {
  subscribedControllers.add(ws);
}

export function getSubscribedControllers(): WebSocket[] {
  return [...subscribedControllers];
}

export function hasExceededAttempts(deviceId: string): boolean {
  const agent = agents.get(deviceId);
  return agent !== undefined && agent.failedAttempts >= MAX_PAIR_ATTEMPTS;
}

export function recordFailedAttempt(deviceId: string): void {
  const agent = agents.get(deviceId);
  if (agent) agent.failedAttempts += 1;
}

export function pairController(deviceId: string, controllerWs: WebSocket): void {
  const agent = agents.get(deviceId);
  if (agent) {
    agent.controllerWs = controllerWs;
    agent.failedAttempts = 0;
  }
}

// Looks up which "other side" a message should be relayed to, given the ws
// that sent it and the deviceId the message references.
export function resolveRelayTarget(deviceId: string, senderWs: WebSocket): WebSocket | undefined {
  const agent = agents.get(deviceId);
  if (!agent) return undefined;
  if (senderWs === agent.ws) return agent.controllerWs ?? undefined;
  if (senderWs === agent.controllerWs) return agent.ws ?? undefined;
  return undefined;
}

// Returns the deviceId that just went offline, if the closed connection was
// a registered agent, so the caller can broadcast the status change.
export function removeConnection(ws: WebSocket): string | undefined {
  subscribedControllers.delete(ws);
  for (const [deviceId, agent] of agents) {
    if (agent.ws === ws) {
      agent.ws = null;
      agent.controllerWs = null;
      agent.online = false;
      return deviceId;
    }
    if (agent.controllerWs === ws) {
      agent.controllerWs = null;
    }
  }
  return undefined;
}
