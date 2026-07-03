import { z } from "zod";

/**
 * Shared message schema between the desktop app (agent/controller modes)
 * and the signaling server. Keeping this in one place prevents protocol
 * drift as both sides evolve independently.
 */

export const RegisterAgentMessage = z.object({
  type: z.literal("register-agent"),
  token: z.string(), // pre-shared token gating who may register an agent
  deviceId: z.string(),
  pin: z.string(), // sent once at registration; server stores only a hash
});

export const RegisterResultMessage = z.object({
  type: z.literal("register-result"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const PairRequestMessage = z.object({
  type: z.literal("pair-request"),
  deviceId: z.string(),
  pin: z.string(),
});

export const PairResultMessage = z.object({
  type: z.literal("pair-result"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const SdpOfferMessage = z.object({
  type: z.literal("sdp-offer"),
  deviceId: z.string(),
  sdp: z.string(),
});

export const SdpAnswerMessage = z.object({
  type: z.literal("sdp-answer"),
  deviceId: z.string(),
  sdp: z.string(),
});

export const IceCandidateMessage = z.object({
  type: z.literal("ice-candidate"),
  deviceId: z.string(),
  candidate: z.string(),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().nullable(),
});

// Keeps the WebSocket connection alive through proxies/tunnels (e.g. a free
// Cloudflare quick tunnel) that silently close idle connections after ~1-2
// minutes of no traffic. Sent by the client on an interval well under that.
export const PingMessage = z.object({
  type: z.literal("ping"),
});

export const PongMessage = z.object({
  type: z.literal("pong"),
});

// A controller asks for the current roster of devices that have ever
// registered with this server (not just currently-online ones), so it can
// show a "Computers" list with online/offline status, Parsec/AnyDesk-style.
export const ListDevicesMessage = z.object({
  type: z.literal("list-devices"),
});

export const DeviceInfo = z.object({
  deviceId: z.string(),
  online: z.boolean(),
});

export const DeviceListMessage = z.object({
  type: z.literal("device-list"),
  devices: z.array(DeviceInfo),
});

// Pushed to every controller that has asked for the list, whenever any
// device's online status changes, so the list updates live without polling.
export const DeviceStatusChangedMessage = z.object({
  type: z.literal("device-status-changed"),
  deviceId: z.string(),
  online: z.boolean(),
});

export const SignalingMessage = z.discriminatedUnion("type", [
  RegisterAgentMessage,
  RegisterResultMessage,
  PairRequestMessage,
  PairResultMessage,
  SdpOfferMessage,
  SdpAnswerMessage,
  IceCandidateMessage,
  PingMessage,
  PongMessage,
  ListDevicesMessage,
  DeviceListMessage,
  DeviceStatusChangedMessage,
]);

export type SignalingMessage = z.infer<typeof SignalingMessage>;
