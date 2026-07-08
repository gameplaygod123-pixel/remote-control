// Builds the command line for our custom DXGI capturer (`capturer.exe`) — the
// Step 3 replacement for ffmpeg/ddagrab. Unlike ffmpeg it has change-detection:
// it skips unchanged AND pointer-only frames (the case ddagrab can't skip), so a
// static screen with the mouse moving encodes ~0 frames (Parsec-level GPU).
//
// Kept a pure function (like buildFfmpegArgs) so the CLI contract is unit-testable
// and reviewable in isolation. The contract is owned here (Mac) and implemented by
// capturer.exe (Windows-Claude) — see docs/step3-dxgi-capturer.md "3c CLI contract".
//
// Output on stdout is byte-identical to ffmpeg's `-f h264 pipe:1`: raw H.264
// Annex-B, 4-byte start codes, in-band SPS/PPS before every IDR, flushed per frame.
// So the whole receive path (NalSplitter/AccessUnitAssembler/RTP + the Mac decoder)
// is UNCHANGED — the capturer just drops in where ffmpeg was.

import type { VideoConfig } from '../shared/contract'
import { NVENC_KEYFRAME_GOP } from './ffmpegArgs'

/**
 * NVENC VBV (bitrate buffer) size in milliseconds. 250ms (`maxrate/4`) is the
 * historical byte-identical default: it lets a single IDR / high-motion / recovery
 * frame balloon into a 130–160-packet burst, and when one coincides with link
 * contention the WHOLE burst is dropped (the self-induced blackout the analyzer
 * measured — see docs/step-fec-recovery.md Layer 1). Parsec's VBV is ≈1 frame, so
 * the same contention costs it only a few SCATTERED packets.
 *
 * FEC Layer 1 shrinks this to ~2 frames (~33ms @ 60fps) to cap per-frame size →
 * bursts become small/scattered (analyzer decider: lostpkts/event 130→single
 * digits), which is also the PRECONDITION for FEC. **We keep the default at 250
 * (byte-identical) until the A/B on real hardware validates the shrink** — the
 * experiment is driven WITHOUT a Mac build via the capturer tune-file (`vbv=33` in
 * %LOCALAPPDATA%\pr-capturer-tune.txt) or env VIDEO_CAPTURER_VBV_MS (both override
 * this CLI value in the capturer). Once the analyzer confirms 33 (or whatever wins)
 * cuts the bursts without a quality hit, flip this constant + ship a prerelease.
 */
export const NVENC_VBV_MS = 250

export interface CapturerArgOptions {
  /** `stdout` (default, the sender path) or a file path (offline .h264 testing). */
  output?: string
  /** DXGI output index to duplicate (0 = primary). */
  outputIdx?: number
  /** IDR interval in frames. Default NVENC_KEYFRAME_GOP (120 ≈ 2s@60). The capturer
   *  MUST NOT use intra-refresh (VideoToolbox can't decode it — see Step 1). */
  gop?: number
  /** NVENC VBR target average (kbps). Default = config.startBitrateKbps. */
  bitrateKbps?: number
  /** NVENC VBR hard cap (kbps). Default = config.maxBitrateKbps. */
  maxBitrateKbps?: number
  /** NVENC VBV buffer size in milliseconds. Default = NVENC_VBV_MS (250, byte-
   *  identical). FEC Layer 1 drives this to ~33 (2 frames @ 60fps) once the A/B
   *  validates it — smaller = smaller per-frame bursts = scattered loss instead of
   *  blackout bursts (see NVENC_VBV_MS). */
  vbvMs?: number
}

/** Our VideoCodec ('h264'|'hevc') -> the capturer's --codec token ('h264'|'h265').
 *  The capturer also accepts 'hevc'/'HEVC' but we normalize to h264/h265. */
function codecArg(codec: VideoConfig['codec']): 'h264' | 'h265' {
  return codec === 'hevc' ? 'h265' : 'h264'
}

/**
 * Full capturer.exe argv (without the binary path). Mirrors the documented 3c CLI
 * contract. `fps` is a CAP (change-detection makes the real rate variable ≤ cap).
 */
export function buildCapturerArgs(config: VideoConfig, opts: CapturerArgOptions = {}): string[] {
  const output = opts.output ?? 'stdout'
  const outputIdx = opts.outputIdx ?? 0
  const gop = opts.gop ?? NVENC_KEYFRAME_GOP
  const bitrateKbps = opts.bitrateKbps ?? config.startBitrateKbps
  const maxBitrateKbps = opts.maxBitrateKbps ?? config.maxBitrateKbps
  const vbvMs = opts.vbvMs ?? NVENC_VBV_MS
  return [
    '--output',
    output,
    '--monitor',
    String(outputIdx),
    // Codec is carried from DEFAULT_VIDEO_CONFIG.codec -> the receiver learns it
    // from the negotiated config too, so both ends agree (H.264 default; H.265 opt-in).
    '--codec',
    codecArg(config.codec),
    '--fps',
    String(config.fps),
    '--bitrate',
    String(bitrateKbps),
    '--maxrate',
    String(maxBitrateKbps),
    '--gop',
    String(gop),
    // VBV buffer (default 250ms = byte-identical). FEC Layer 1 will shrink to ~2
    // frames so per-frame bursts stay small (scattered loss vs 130-packet blackout
    // bursts) once the tune-file A/B validates it — see NVENC_VBV_MS.
    '--vbv-ms',
    String(vbvMs)
  ]
}
