// Frozen foundation for the native video pipeline (see docs/native-video-plan.md).
//
// BOTH halves build against this file + ipc.ts and nothing else of each other's:
//   - the Windows sender  -> video-native/sender   (DXGI capture, HW encode, RTP send)
//   - the Mac receiver    -> video-native/receiver  (RTP recv, VideoToolbox decode, render)
//
// Phase 0 FREEZES these types. Changing one later forces both sides to re-sync,
// so this is the "get it right before feature work" foundation the owner asked
// for. Keep it pure types + constants -- no native imports, no side effects --
// so it typechecks and both a Node helper and the Electron renderer can import it.

/**
 * Advertised on the pair / sdp-offer `caps` array (same mechanism as the
 * existing 'input-helper' capability). The native pipeline only engages when
 * BOTH peers advertise it; a peer that doesn't send or understand it makes the
 * session silently fall back to the WebRTC `<video>` path. Old signaling
 * servers strip unknown fields, so this degrades gracefully by design.
 */
export const NATIVE_VIDEO_CAP = 'native-video' as const

/**
 * Which video pipeline a session actually uses. Default stays 'webrtc' until
 * native is proven on real hardware (golden rule #1); overridable via the
 * VIDEO_PIPELINE env var or a settings toggle. Selecting 'native' only takes
 * effect if both peers advertised NATIVE_VIDEO_CAP -- otherwise 'webrtc'.
 */
export type VideoPipeline = 'webrtc' | 'native'
export const DEFAULT_VIDEO_PIPELINE: VideoPipeline = 'webrtc'
export const VIDEO_PIPELINE_ENV = 'VIDEO_PIPELINE'

/**
 * Hardware codecs the native path may negotiate. H.264 is the safe default
 * (universal HW encode on Windows / decode on Mac). HEVC is opt-in and only if
 * BOTH ends report hardware support in the Phase 1 capability probe -- never
 * assume it.
 */
export type VideoCodec = 'h264' | 'hevc'

/**
 * Capture + encode parameters the controller requests and the agent's sender
 * applies. Defaults deliberately mirror the tuned WebRTC values proven in
 * v1.22.0 (see agent/AgentView.tsx history) so the native path starts at
 * known-good numbers instead of re-discovering them.
 */
export interface VideoConfig {
  width: number // 1920
  height: number // 1080
  fps: number // 60
  codec: VideoCodec
  /** Floor that stops the encoder collapsing to a blurry trickle on a quiet
   *  link -- the exact failure v1.22.0 fixed with x-google-min-bitrate. */
  minBitrateKbps: number // 6000
  startBitrateKbps: number // 20000
  maxBitrateKbps: number // 30000
  /**
   * 'composited' draws the OS cursor into the captured frame (simple, but the
   * cursor then carries the full round-trip lag). 'separate' streams cursor
   * position/shape on a side channel for the Mac to draw LOCALLY -- Parsec-like
   * instant-cursor feel, more work. Decision lands in Phase 1; the interface
   * carries it from day one so neither side has to change shape later.
   */
  cursor: 'composited' | 'separate'
}

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  width: 1920,
  height: 1080,
  fps: 60,
  codec: 'h264',
  minBitrateKbps: 6_000,
  startBitrateKbps: 20_000,
  maxBitrateKbps: 30_000,
  cursor: 'composited'
}

/**
 * Per-second pipeline telemetry each helper reports to its Electron main,
 * surfaced in the existing session HUD (the native-path counterpart to
 * shared/webrtc/useVideoStats). Fields intentionally match what the WebRTC HUD
 * already shows so the UI need not branch: the sender fills capture/encode, the
 * receiver fills decode/render, and the half that doesn't apply is null.
 */
export interface NativeVideoStats {
  fps: number
  width: number
  height: number
  kbps: number
  captureMs: number | null // sender: DXGI acquire -> encoder submit
  encodeMs: number | null // sender: HW encode time / frame
  decodeMs: number | null // receiver: VideoToolbox decode / frame
  renderMs: number | null // receiver: decode -> on-screen present (the <video> wall we're removing)
  rttMs: number | null
  codec: VideoCodec | null
}
