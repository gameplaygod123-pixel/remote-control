import type { WebSocket } from "ws";

const MAX_PAIR_ATTEMPTS = 5;

export interface AgentRecord {
  ws: WebSocket | null; // null while offline -- the record itself persists
  pinHash: string;
  controllerWs: WebSocket | null;
  failedAttempts: number;
  online: boolean;
  name?: string;
  thumbnail?: string;
  // A controller with a correct PIN, waiting on the agent operator to
  // accept/reject before the session actually starts. Not the same as
  // controllerWs, which is only set once the connection is truly live.
  pendingControllerWs?: WebSocket | null;
}

export interface DeviceInfo {
  deviceId: string;
  online: boolean;
  name?: string;
  thumbnail?: string;
}

// In-memory only -- fine for a personal, single-user relay. Restarting the
// signaling server drops the whole device roster, which is an acceptable
// trade-off for the free-tier setup described in the plan.
const agents = new Map<string, AgentRecord>();

// Controllers that asked for the device list, so we know who to push
// "device-status-changed" updates to as agents come and go.
const subscribedControllers = new Set<WebSocket>();

export function registerAgent(
  deviceId: string,
  ws: WebSocket,
  pinHash: string,
  name?: string,
): void {
  const existing = agents.get(deviceId);
  agents.set(deviceId, {
    ws,
    pinHash,
    controllerWs: null,
    failedAttempts: 0,
    online: true,
    name: name ?? existing?.name,
    thumbnail: existing?.thumbnail,
  });
}

export function getAgent(deviceId: string): AgentRecord | undefined {
  return agents.get(deviceId);
}

// Relabels an already-registered agent without touching its live
// ws/controllerWs/pinHash -- renaming must never disrupt an active pairing.
export function setDeviceName(deviceId: string, name: string): void {
  const agent = agents.get(deviceId);
  if (agent) agent.name = name;
}

export function setDeviceThumbnail(deviceId: string, image: string): void {
  const agent = agents.get(deviceId);
  if (agent) agent.thumbnail = image;
}

// Only removes an offline device -- an online one has a live ws/controllerWs
// that a list-cleanup action shouldn't silently sever. Returns false (no-op)
// if the device doesn't exist or is currently online.
export function removeDevice(deviceId: string): boolean {
  const agent = agents.get(deviceId);
  if (!agent || agent.online) return false;
  agents.delete(deviceId);
  return true;
}

export function listDevices(): DeviceInfo[] {
  return [...agents.entries()].map(([deviceId, agent]) => ({
    deviceId,
    online: agent.online,
    name: agent.name,
    thumbnail: agent.thumbnail,
  }));
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

export function setPendingController(deviceId: string, ws: WebSocket): void {
  const agent = agents.get(deviceId);
  if (agent) agent.pendingControllerWs = ws;
}

// Consumes the pending controller, if any -- a given pending request can
// only be resolved (accepted, rejected, or timed out) once.
export function takePendingController(deviceId: string): WebSocket | null {
  const agent = agents.get(deviceId);
  if (!agent) return null;
  const ws = agent.pendingControllerWs ?? null;
  agent.pendingControllerWs = null;
  return ws;
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

export interface RemoveConnectionResult {
  // Set if the closed connection was a registered agent, so the caller can
  // broadcast the status change.
  offlineDeviceId?: string;
  // Set if the closed connection was an agent that had a controller still
  // waiting on an accept/reject decision -- that controller needs to be
  // told the request failed rather than being left hanging forever.
  orphanedPendingController?: WebSocket;
}

export function removeConnection(ws: WebSocket): RemoveConnectionResult {
  subscribedControllers.delete(ws);
  for (const [deviceId, agent] of agents) {
    if (agent.ws === ws) {
      agent.ws = null;
      agent.controllerWs = null;
      agent.online = false;
      const orphanedPendingController = agent.pendingControllerWs ?? undefined;
      agent.pendingControllerWs = null;
      return { offlineDeviceId: deviceId, orphanedPendingController };
    }
    if (agent.controllerWs === ws) {
      agent.controllerWs = null;
    }
    // The pending controller itself disconnected while waiting -- clear it
    // so the agent's prompt doesn't resolve into responding to no one.
    if (agent.pendingControllerWs === ws) {
      agent.pendingControllerWs = null;
    }
  }
  return {};
}
