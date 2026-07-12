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
  name: z.string().optional(), // human-friendly label, e.g. "Bedroom PC"
  os: z.string().optional(), // display string, e.g. "Windows" -- roster column
});

export const RegisterResultMessage = z.object({
  type: z.literal("register-result"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

// `caps` advertises optional protocol capabilities the sender supports, e.g.
// "input-helper" (a native input-helper process, see docs/native-input-plan.md).
// Absent/empty is exactly what every existing client sends (they don't know
// this field exists), which correctly reads as "supports nothing extra" and
// falls back to the original behavior -- never a breaking change.
export const PairRequestMessage = z.object({
  type: z.literal("pair-request"),
  deviceId: z.string(),
  pin: z.string(),
  controllerId: z.string(), // lets the agent recognize a previously-trusted controller
  caps: z.array(z.string()).optional(),
  // Same pre-shared "house token" agents use to register. Optional in the
  // schema only so old clients still *parse*; the server rejects a missing/
  // wrong token, so the PIN can never be brute-forced by strangers who found
  // the (public) signaling URL.
  token: z.string().optional(),
});

export const PairResultMessage = z.object({
  type: z.literal("pair-result"),
  ok: z.boolean(),
  reason: z.string().optional(),
  // The *agent's* caps, populated by the server from the agent's
  // connection-response when relaying its accept as this pair-result to the
  // controller -- lets the controller know, at the moment pairing succeeds,
  // whether the agent has a native input-helper it can negotiate against.
  caps: z.array(z.string()).optional(),
});

// `channel` distinguishes which of the agent's (potentially several) peer
// connections a message belongs to: the video PC (screen share, still
// renderer-owned) vs. the input PC (owned by the agent's native input-helper
// process -- see docs/native-input-plan.md). Absent/omitted means "video",
// so every message an old client ever sent -- none of which know this field
// exists -- still parses and routes exactly as before.
//
// "video-native" is the NATIVE video pipeline's own PC (agent's forked
// video-sender process -> Mac native receiver; see docs/native-video-plan.md).
// It's a SEPARATE channel from "video" on purpose: in native mode the renderer
// "video" PC still exists to carry file transfer (and input/clipboard when the
// input-helper isn't engaged), so the native video PC needs its own tag or the
// two collide. Same three message types (sdp-offer/answer/ice-candidate), just a
// new channel value -- additive, exactly like "input" was. NOTE: the server
// validates messages against this enum (server/signaling/src/index.ts drops
// invalid ones), so a deployed server must be rebuilt/restarted to relay
// "video-native" (same redeploy that "input" needed).
export const SignalChannel = z.enum(["video", "input", "video-native"]);

export const SdpOfferMessage = z.object({
  type: z.literal("sdp-offer"),
  deviceId: z.string(),
  sdp: z.string(),
  channel: SignalChannel.optional(),
});

export const SdpAnswerMessage = z.object({
  type: z.literal("sdp-answer"),
  deviceId: z.string(),
  sdp: z.string(),
  channel: SignalChannel.optional(),
});

export const IceCandidateMessage = z.object({
  type: z.literal("ice-candidate"),
  deviceId: z.string(),
  candidate: z.string(),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().nullable(),
  channel: SignalChannel.optional(),
});

// BWE (native video): the controller's loss-based estimator tells the agent's
// sender what bitrate to encode at (≤60 Mbps cap). The native video pc is
// media-only (no data channel), so the target rides the signaling channel like
// SDP/ICE -- the server just relays it between the paired sockets (resolveRelayTarget),
// never inspecting it. `channel` is 'video-native' (additive, like the SDP types).
// Old servers drop unknown message types on parse, so a server that hasn't been
// rebuilt simply never relays it -> the sender stays at its fixed launch bitrate
// (graceful degrade, exactly like 'video-native' SDP needed a server rebuild).
export const VideoBitrateMessage = z.object({
  type: z.literal("video-bitrate"),
  deviceId: z.string(),
  kbps: z.number(),
  channel: SignalChannel.optional(),
});

// Native-video sender telemetry (agent -> controller): the encode/capture time per
// frame that only the agent's capturer/NVENC knows, surfaced in the controller's HUD
// (the media-only native pc has no back-channel, so it rides signaling like
// video-bitrate). Relayed unchanged by the server (resolveRelayTarget). Values are
// nullable -- ffmpeg exposes no per-frame split; the custom capturer fills encodeMs.
export const VideoSenderStatsMessage = z.object({
  type: z.literal("video-sender-stats"),
  deviceId: z.string(),
  encodeMs: z.number().nullable(),
  captureMs: z.number().nullable(),
  channel: SignalChannel.optional(),
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
  // House token (see PairRequestMessage) -- the device roster includes names
  // and live thumbnails, which strangers must not see.
  token: z.string().optional(),
});

export const DeviceInfo = z.object({
  deviceId: z.string(),
  online: z.boolean(),
  name: z.string().optional(),
  thumbnail: z.string().optional(), // data URL, low-res preview -- see device-thumbnail
  os: z.string().optional(), // from register-agent; absent for pre-os agents
  lastSeenAt: z.number().optional(), // epoch ms of last register/disconnect
});

export const DeviceListMessage = z.object({
  type: z.literal("device-list"),
  devices: z.array(DeviceInfo),
});

// Pushed to every controller that has asked for the list, whenever any
// device's online status *or name* changes, so the list updates live
// without polling.
export const DeviceStatusChangedMessage = z.object({
  type: z.literal("device-status-changed"),
  deviceId: z.string(),
  online: z.boolean(),
  name: z.string().optional(),
  os: z.string().optional(),
  lastSeenAt: z.number().optional(),
});

// Sent by an already-registered agent to relabel itself without touching
// its live pairing/connection state -- re-sending register-agent would
// reset the whole record (including the active controllerWs), disconnecting
// anyone currently connected just to change a display name.
export const SetDeviceNameMessage = z.object({
  type: z.literal("set-device-name"),
  deviceId: z.string(),
  name: z.string(),
});

// A low-res (~320x200), throttled preview screenshot pushed by an online
// agent every few seconds so the controller's device list can show what
// each machine currently looks like, Parsec/AnyDesk-style -- separate from
// the real video track, which only exists once a controller actually pairs
// and opens a full session.
export const DeviceThumbnailMessage = z.object({
  type: z.literal("device-thumbnail"),
  deviceId: z.string(),
  image: z.string(), // data URL, e.g. "data:image/jpeg;base64,..."
});

// A correct PIN alone no longer opens a live session -- the person at the
// agent machine gets asked to accept or reject the incoming connection
// first (unless the agent already recognizes this controllerId as
// trusted from a prior accept, handled entirely client-side on the agent).
// Sent to the agent right after PIN verification succeeds.
export const ConnectionRequestMessage = z.object({
  type: z.literal("connection-request"),
  deviceId: z.string(),
  controllerId: z.string(),
  // The *controller's* caps, carried through from its pair-request so the
  // agent knows -- before it even answers -- whether this controller can
  // negotiate a native input-helper session at all.
  caps: z.array(z.string()).optional(),
});

// The agent's answer to a ConnectionRequestMessage.
export const ConnectionResponseMessage = z.object({
  type: z.literal("connection-response"),
  deviceId: z.string(),
  accept: z.boolean(),
  caps: z.array(z.string()).optional(),
});

// Sent to the controller in place of an immediate pair-result, so its UI
// can show "waiting for approval" instead of looking stuck on "pairing".
export const PairingPendingMessage = z.object({
  type: z.literal("pairing-pending"),
});

// Lets a controller clear an old/unused entry out of the "Computers" list
// -- e.g. a test device from earlier development that will never come
// back online. Only takes effect for an offline device; the server
// silently ignores it for a currently-online one rather than disconnecting
// it as a side effect of a list-cleanup action.
export const RemoveDeviceMessage = z.object({
  type: z.literal("remove-device"),
  deviceId: z.string(),
  // House token (see PairRequestMessage) -- removal is destructive.
  token: z.string().optional(),
});

// Pushed to every subscribed controller once a device is actually removed,
// so every open "Computers" list drops it live instead of only the one
// that clicked Remove.
export const DeviceRemovedMessage = z.object({
  type: z.literal("device-removed"),
  deviceId: z.string(),
});

// Server-to-client: something about the request itself was unacceptable
// (today: a missing/wrong house token on messages that have no dedicated
// failure reply, like list-devices). Old clients drop unknown message types
// on parse, so adding this is backward compatible; new clients use it to
// show "fix your token" instead of a silent disconnect loop.
export const ServerErrorMessage = z.object({
  type: z.literal("server-error"),
  reason: z.string(),
});

// A single ICE server entry, browser-RTCIceServer-shaped so the renderer can use
// it directly and the node/ndc paths can convert it. Delivered by the server so
// short-lived TURN credentials (Cloudflare) can be minted centrally and refreshed
// without any client holding the TURN API token.
export const IceServerConfig = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerConfig>;

// Client asks the server for the current ICE servers (STUN + freshly-minted TURN).
// Token-gated like every other privileged request.
export const GetIceServersMessage = z.object({
  type: z.literal("get-ice-servers"),
  token: z.string(),
});

// Server's reply: the ICE servers to use. Empty/absent TURN (server has no TURN
// configured) just leaves clients on their baked-in STUN -- graceful, no break.
export const IceServersMessage = z.object({
  type: z.literal("ice-servers"),
  iceServers: z.array(IceServerConfig),
});

export const SignalingMessage = z.discriminatedUnion("type", [
  ServerErrorMessage,
  RegisterAgentMessage,
  RegisterResultMessage,
  PairRequestMessage,
  PairResultMessage,
  SdpOfferMessage,
  SdpAnswerMessage,
  IceCandidateMessage,
  VideoBitrateMessage,
  VideoSenderStatsMessage,
  PingMessage,
  PongMessage,
  ListDevicesMessage,
  DeviceListMessage,
  DeviceStatusChangedMessage,
  SetDeviceNameMessage,
  DeviceThumbnailMessage,
  ConnectionRequestMessage,
  ConnectionResponseMessage,
  PairingPendingMessage,
  RemoveDeviceMessage,
  DeviceRemovedMessage,
  GetIceServersMessage,
  IceServersMessage,
]);

export type SignalingMessage = z.infer<typeof SignalingMessage>;
