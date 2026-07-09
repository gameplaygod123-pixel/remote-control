// IPC contract between Electron main and each forked native-video helper.
//
// Deliberately shaped like the input helper's HelperToMain / InputHelperHost
// (main/inputHelperHost.ts) so the supervisor mechanics that already work --
// fork-as-Node, respawn on crash, ping/pong liveness, ICE relay through main --
// can be COPIED rather than reinvented. Read that file before wiring these.
//
// Negotiation direction (unchanged from today): the AGENT is the SDP offerer,
// the CONTROLLER answers. So the sender helper (agent/Windows) creates the
// offer + owns the media track; the receiver helper (controller/Mac) answers.
// Both are separate native processes outside Chromium; main only relays their
// SDP/ICE over the existing signaling and positions the receiver's render.

import type { IceServerConfig, NativeVideoStats, VideoCodec, VideoConfig } from './contract'

// ────────────────────────────────────────────────────────────────────────────
// Sender = agent (Windows). Owns DXGI capture + HW encode + the outbound track.
// ────────────────────────────────────────────────────────────────────────────

export type VideoSenderToMain =
  | { evt: 'ready' }
  | { evt: 'offer'; sdp: string }
  | { evt: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { evt: 'stats'; stats: NativeVideoStats }
  | { evt: 'pong' }
  | { evt: 'fatal'; message: string }

export type MainToVideoSender =
  | { cmd: 'start-session'; config: VideoConfig; iceServers?: IceServerConfig[] }
  | { cmd: 'remote-answer'; sdp: string }
  | { cmd: 'remote-ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { cmd: 'stop-session' }
  /** BWE: a new VBR target (kbps) from the Mac receiver's AIMD, relayed here over
   *  signaling. The helper forwards it to the capturer stdin ('B<kbps>') for a live
   *  NVENC reconfigure (no respawn). See receiver/bwe.ts + docs/bwe-hevc-plan.md. */
  | { cmd: 'set-bitrate'; kbps: number }
  | { cmd: 'ping' }

/** Main-side handle over the sender helper (mirror of InputHelperHost). */
export interface VideoSenderHost {
  isReady(): boolean
  startSession(config: VideoConfig, iceServers?: IceServerConfig[]): void
  remoteAnswer(sdp: string): void
  remoteIce(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void
  /** BWE: forward a new VBR target (kbps) to the capturer for a live retune. */
  setBitrate(kbps: number): void
  stopSession(): void
  destroy(): void
}

export interface VideoSenderCallbacks {
  onOffer: (sdp: string) => void
  onIce: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  onStats: (stats: NativeVideoStats) => void
  /** Crash / hang / never-ready. Caller drops the in-flight native session and
   *  falls back to the WebRTC path for the next pairing (see AgentView's
   *  isReady() fallback pattern). */
  onDown: () => void
}

// ────────────────────────────────────────────────────────────────────────────
// Receiver = controller (Mac). Owns RTP recv + VideoToolbox decode + render.
// ────────────────────────────────────────────────────────────────────────────

export type VideoReceiverToMain =
  | { evt: 'ready' }
  | { evt: 'answer'; sdp: string }
  | { evt: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /**
   * One reassembled Annex-B access unit. The receiver child no longer spawns a
   * Swift render process -- it hands compressed frames to MAIN, which pushes them
   * into the in-process render surface (librvr.dylib, embed.swift) so the video
   * composites INSIDE the Electron window. Sent over an 'advanced'-serialized fork
   * channel so the Buffer transfers efficiently at 60fps.
   */
  | { evt: 'au'; data: Buffer }
  /** Codec auto-detected from the offer SDP (H265 => the agent opted into hevc).
   *  Main sets the in-process decoder (setNativeCodec -> librvr rvr_set_codec) so it
   *  builds the right CMFormatDescription BEFORE the first AU arrives. */
  | { evt: 'codec'; codec: VideoCodec }
  /** First decoded frame is on screen -- renderer can drop its "connecting…"
   *  overlay. Cheap signal that avoids guessing from stats. */
  | { evt: 'first-frame' }
  | { evt: 'stats'; stats: NativeVideoStats }
  /** BWE: a new sender bitrate target (kbps) from the receiver's loss-based AIMD.
   *  Main relays it over signaling ('video-bitrate') to the agent, which forwards
   *  it to the capturer stdin ('B<kbps>'). See receiver/bwe.ts + docs/bwe-hevc-plan.md. */
  | { evt: 'bitrate'; kbps: number }
  | { evt: 'pong' }
  | { evt: 'fatal'; message: string }

export type MainToVideoReceiver =
  | { cmd: 'start-session' }
  | { cmd: 'remote-offer'; sdp: string }
  | { cmd: 'remote-ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { cmd: 'stop-session' }
  | { cmd: 'ping' }

/** Main-side handle over the receiver helper. */
export interface VideoReceiverHost {
  isReady(): boolean
  startSession(): void
  remoteOffer(sdp: string): void
  remoteIce(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void
  stopSession(): void
  destroy(): void
}

export interface VideoReceiverCallbacks {
  onAnswer: (sdp: string) => void
  onIce: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  /** One Annex-B access unit -> push into the in-process render surface. */
  onAu: (au: Buffer) => void
  /** Codec detected from the offer -> set the native decoder before AUs arrive. */
  onCodec: (codec: VideoCodec) => void
  onFirstFrame: () => void
  onStats: (stats: NativeVideoStats) => void
  /** BWE: a new sender bitrate target (kbps) to relay over signaling to the agent. */
  onBitrate: (kbps: number) => void
  onDown: () => void
}
