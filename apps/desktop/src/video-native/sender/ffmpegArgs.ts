// Builds the ffmpeg command line for the Windows sender's capture+encode stage.
//
// This is the exact low-latency flag set proven in Phase 1 (measured on the real
// RTX 3060 Ti agent -- see phase1/NOTES.md #2 and native/phase0-ffmpeg/RESULTS.md):
//   DXGI Desktop Duplication (ddagrab) -> h264_nvenc GPU zero-copy (or h264_mf
//   fallback via hwdownload) -> Annex-B elementary stream on stdout (pipe:1).
//
// Kept as a pure function (no spawn, no side effects) so the flag set is unit-
// testable and reviewable in isolation -- deviating from the measured-good flags
// is the kind of thing that silently reintroduces encoder buffering latency, so
// they live in ONE place, documented, not scattered across the helper.

import type { VideoConfig } from '../shared/contract'

/** Which ffmpeg encoder the sender drives. NVENC is the primary (GPU zero-copy,
 *  ~7% CPU at 1440p60); MF is the vendor-agnostic fallback for non-NVIDIA GPUs
 *  (needs a per-frame GPU->CPU hwdownload, ~130% CPU) -- see RESULTS.md §C. */
export type SenderEncoder = 'h264_nvenc' | 'h264_mf'

/** `-g` (IDR interval, frames) used WITH intra-refresh. Step 1 first tried a huge
 *  value (999999 = one IDR ever, refresh rolls through P-frames) but that REGRESSED
 *  on the VideoToolbox receiver: AVSampleBufferDisplayLayer needs a periodic IDR to
 *  recover from any loss/reference gap -- it does NOT resume off intra-refresh's
 *  rolling recovery -- so with no periodic IDR the Mac froze mid-session and had to
 *  reconnect (WC, real hardware, v1.25.1-beta.2). So we keep intra-refresh (flatter
 *  bitrate: the refresh spreads the keyframe cost across P-frames) but restore a
 *  MODERATE periodic IDR safety net: 120 frames = an IDR every ~2s at 60fps. That
 *  halves v1.25.0's 1s-IDR spike frequency while giving VT a self-heal point at
 *  least every 2s; PLI still forces an IDR on demand. */
export const NVENC_INTRA_REFRESH_GOP = 120

export interface FfmpegArgOptions {
  /** `-g` (IDR interval) in frames. With intra-refresh (Step 1) this is a MODERATE
   *  periodic-IDR safety net (NVENC_INTRA_REFRESH_GOP = 120 ≈ 2s at 60fps) that the
   *  VideoToolbox receiver needs to auto-recover from loss; the refresh spreads the
   *  keyframe cost across P-frames so the spike is milder than a per-second IDR.
   *  Override only for tests / experiments. */
  gop?: number
  encoder?: SenderEncoder
  /** DXGI output index to duplicate (0 = primary). Multi-monitor is Phase 3. */
  outputIdx?: number
  /** NVENC preset p1 (fastest) .. p7 (slowest/best quality). Default 'p1'.
   *  Quality-sweep knob (env VIDEO_NVENC_PRESET at the call site) — p1→p4 is the
   *  Mac-approved sweep to try at the real-ffmpeg run. Ignored by the MF fallback. */
  preset?: string
  /** VBR target average in kbps. Default = config.startBitrateKbps. Sweep knob
   *  (env VIDEO_NVENC_BITRATE_KBPS). Applies to both encoders. */
  bitrateKbps?: number
  /** VBR hard cap in kbps. Default = config.maxBitrateKbps. The `-maxrate` ceiling. */
  maxBitrateKbps?: number
}

/**
 * The measured-good low-latency encoder flags. NB: this is the SAME set the
 * phase1/ffmpeg-pipe.mjs harness ran when it recorded "frames flush one-at-a-time
 * at 16.55ms = 60fps exactly" -- change these only with a fresh pipe-cadence
 * measurement, not by eye.
 */
function encoderArgs(
  encoder: SenderEncoder,
  gop: number,
  preset: string,
  bitrateKbps: number,
  maxBitrateKbps: number
): string[] {
  const bitrate = `${bitrateKbps}k`
  if (encoder === 'h264_nvenc') {
    // VBR (was CBR): the target is the AVERAGE, `-maxrate` the hard cap. A static
    // screen falls to a few Mbps (like Parsec) instead of pumping the full rate
    // constantly -- big cut in average traffic, which is what strained ICE at 60
    // Mbps CBR. `-bufsize` ~250ms keeps the burst bounded so latency stays low;
    // `-tune ull` + `-bf 0` + `-zerolatency` keep the per-frame path low-latency.
    return [
      '-c:v',
      'h264_nvenc',
      '-preset',
      preset, // p1 (fastest) default; p1→p4 quality sweep
      '-tune',
      'ull', // ultra-low-latency
      '-rc',
      'vbr',
      '-b:v',
      bitrate, // VBR target average (sweepable via env)
      '-maxrate',
      `${maxBitrateKbps}k`, // hard cap (owner: ≤40 Mbps)
      '-bufsize',
      `${Math.max(1, Math.round(maxBitrateKbps / 4))}k`, // ~250ms burst bound
      '-bf',
      '0', // NO B-frames (no reorder delay)
      // Intra-refresh ON TOP OF a moderate periodic IDR (Step 1, guide §4.1 --
      // streaming-improvements-plan.md). Intra-refresh rolls the refresh across a
      // band of P-frames every cycle so the keyframe cost is spread out (milder
      // bitrate bumps than a hard per-second IDR). We do NOT drop the periodic IDR
      // entirely: pure intra-refresh (`-g 999999`) FROZE the VideoToolbox receiver
      // (it only resumes off a real IDR, not off rolling recovery -- WC, real
      // hardware, beta.2), so `-g` = NVENC_INTRA_REFRESH_GOP (120 ≈ 2s@60fps) keeps
      // a self-heal point every ~2s. `-forced-idr` also lets a PLI / session-start
      // force a REAL IDR on demand, and `-bsf:v dump_extra` repeats SPS/PPS in-band
      // so a mid-stream join / post-respawn decoder still gets parameter sets.
      '-intra-refresh',
      '1',
      '-forced-idr',
      '1',
      '-g',
      String(gop),
      '-delay',
      '0', // no output reorder delay
      '-zerolatency',
      '1',
      '-rc-lookahead',
      '0',
      '-no-scenecut',
      '1' // keep GOP deterministic (no surprise I-frames)
    ]
  }
  // Media Foundation fallback: fewer knobs than nvenc; the input is already CPU
  // (bgra) after hwdownload in the filter chain below, so no GPU-encoder flags.
  return ['-c:v', 'h264_mf', '-b:v', bitrate, '-maxrate', `${maxBitrateKbps}k`]
}

/**
 * Filter chain: DXGI duplication of the chosen output at the target fps, scaled
 * to the requested VideoConfig resolution.
 *  - NVENC path stays fully on the GPU: ddagrab -> scale_d3d11(...:format=nv12).
 *    (Plain scale_d3d11 without format=nv12 errored "Unsupported pixel format" on
 *    the real box -- RESULTS.md "known wiring detail" -- so format is explicit.)
 *  - MF path must hand CPU frames to h264_mf, so it hwdownloads then CPU-scales.
 */
function filterChain(encoder: SenderEncoder, config: VideoConfig, outputIdx: number): string {
  // dup_frames=0: emit a frame ONLY when the desktop actually changes (framerate
  // is the CAP, not a constant). Default (dup_frames=1) pads to a constant fps, so
  // NVENC re-encodes the same static screen 60×/s -- ~45% of the Video Encode
  // engine doing nothing useful. On-change capture is how Parsec sits near-idle on
  // a still screen; our RTP path already uses wall-clock timestamps for exactly
  // this variable interval (phase1/NOTES #64).
  //
  // draw_mouse: 0 with cursor:'separate'. dup_frames=0 ALONE didn't cut the GPU in
  // real use -- with the cursor composited (draw_mouse=1) every mouse-only move is
  // a "desktop change", so during actual control (mouse moving nonstop) NVENC still
  // re-encoded ~40fps (~40% Video-Encode, vs Parsec's ~6%). Parsec draws the cursor
  // as a separate overlay, NOT baked into the video; we do the same -- the agent
  // reports the cursor SHAPE out of band (input-helper/cursorCapture.ts) and the Mac
  // draws it natively (CSS). With the cursor OUT of the frame, a mouse-only move is
  // no longer a change, so the encoder actually idles on a static screen. 1 keeps
  // the OS cursor in the frame (the old composited path) for cursor:'composited'.
  const drawMouse = config.cursor === 'separate' ? 0 : 1
  const grab = `ddagrab=output_idx=${outputIdx}:framerate=${config.fps}:dup_frames=0:draw_mouse=${drawMouse}`
  if (encoder === 'h264_nvenc') {
    // TRUE zero-copy: hand ddagrab's D3D11 RGB surface straight to NVENC, which
    // ingests the d3d11 frame and does RGB->NV12 on-GPU internally (verified:
    // "Using input frames context (format d3d11) with h264_nvenc encoder").
    // We deliberately do NOT insert scale_d3d11 -- the golden-rule-#1 real-ffmpeg
    // run found its D3D11 VideoProcessor cannot configure a BGRA->NV12 output pad
    // on this GPU/driver (reproduced on ffmpeg 8.1 release AND master 2026, fails
    // even for a plain resize), and CUDA hwmap is "not implemented" here too. So
    // there is no working GPU downscale path -- NVENC encodes at the native
    // capture resolution (config.width/height is advisory for this path; the
    // helper reports the real size from ffmpeg). This is also lower-latency than
    // the old design: capture -> encode with zero intermediate filter passes.
    return grab
  }
  // MF fallback (non-NVIDIA): must hand CPU frames to h264_mf, so hwdownload then
  // CPU-scale to the target resolution.
  return `${grab},hwdownload,format=bgra,scale=${config.width}:${config.height}`
}

/**
 * Full ffmpeg argv (without the binary path). Output is a raw H.264 Annex-B
 * elementary stream on stdout:
 *  - `-bsf:v dump_extra` keeps SPS/PPS in-band before every IDR (so a mid-stream
 *    join / post-respawn decoder gets parameter sets without an out-of-band SDP).
 *  - `-flush_packets 1` stops the muxer buffering -> each frame leaves promptly.
 *  - `-f h264 pipe:1` = elementary stream to stdout, the format H264RtpPacketizer
 *    ('LongStartSequence') consumes.
 */
export function buildFfmpegArgs(config: VideoConfig, opts: FfmpegArgOptions = {}): string[] {
  const gop = opts.gop ?? NVENC_INTRA_REFRESH_GOP
  const encoder = opts.encoder ?? 'h264_nvenc'
  const outputIdx = opts.outputIdx ?? 0
  const preset = opts.preset ?? 'p1'
  const bitrateKbps = opts.bitrateKbps ?? config.startBitrateKbps
  const maxBitrateKbps = opts.maxBitrateKbps ?? config.maxBitrateKbps
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_complex',
    filterChain(encoder, config, outputIdx),
    ...encoderArgs(encoder, gop, preset, bitrateKbps, maxBitrateKbps),
    '-bsf:v',
    'dump_extra',
    '-f',
    'h264',
    '-flush_packets',
    '1',
    'pipe:1'
  ]
}
