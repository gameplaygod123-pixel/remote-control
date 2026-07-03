import type { WebSocket } from "ws";

const MAX_PAIR_ATTEMPTS = 5;

export interface AgentRecord {
  ws: WebSocket;
  pinHash: string;
  controllerWs: WebSocket | null;
  failedAttempts: number;
}

// In-memory only -- fine for a personal, single-user relay. Restarting the
// signaling server drops all agents/pairings, which is an acceptable
// trade-off for the free-tier setup described in the plan.
const agents = new Map<string, AgentRecord>();

export function registerAgent(deviceId: string, ws: WebSocket, pinHash: string): void {
  agents.set(deviceId, { ws, pinHash, controllerWs: null, failedAttempts: 0 });
}

export function getAgent(deviceId: string): AgentRecord | undefined {
  return agents.get(deviceId);
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
  if (senderWs === agent.controllerWs) return agent.ws;
  return undefined;
}

export function removeConnection(ws: WebSocket): void {
  for (const [deviceId, agent] of agents) {
    if (agent.ws === ws) {
      agents.delete(deviceId);
    } else if (agent.controllerWs === ws) {
      agent.controllerWs = null;
    }
  }
}
