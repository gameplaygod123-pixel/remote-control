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

export interface FfmpegArgOptions {
  /** GOP length in frames. Short GOP self-heals corruption within ~1 GOP at
   *  ~no bitrate cost under CBR (phase1/NOTES #1.2). Default 60 = 1s @ 60fps. */
  gop?: number
  encoder?: SenderEncoder
  /** DXGI output index to duplicate (0 = primary). Multi-monitor is Phase 3. */
  outputIdx?: number
  /** NVENC preset p1 (fastest) .. p7 (slowest/best quality). Default 'p1'.
   *  Quality-sweep knob (env VIDEO_NVENC_PRESET at the call site) — p1→p4 is the
   *  Mac-approved sweep to try at the real-ffmpeg run. Ignored by the MF fallback. */
  preset?: string
  /** CBR target in kbps. Default = config.startBitrateKbps (20 Mbps). Quality-sweep
   *  knob (env VIDEO_NVENC_BITRATE_KBPS) — the 20→30 Mbps sweep. Applies to both encoders. */
  bitrateKbps?: number
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
  bitrateKbps: number
): string[] {
  const bitrate = `${bitrateKbps}k` // fixed CBR for v1 (item D); change = respawn
  if (encoder === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', preset, // p1 (fastest) default; p1→p4 quality sweep
      '-tune', 'ull', // ultra-low-latency
      '-rc', 'cbr',
      '-b:v', bitrate,
      '-bf', '0', // NO B-frames (no reorder delay)
      '-g', String(gop),
      '-delay', '0', // no output reorder delay
      '-zerolatency', '1',
      '-rc-lookahead', '0',
      '-no-scenecut', '1' // keep GOP deterministic (no surprise I-frames)
    ]
  }
  // Media Foundation fallback: fewer knobs than nvenc; the input is already CPU
  // (bgra) after hwdownload in the filter chain below, so no GPU-encoder flags.
  return ['-c:v', 'h264_mf', '-b:v', bitrate]
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
  const grab = `ddagrab=output_idx=${outputIdx}:framerate=${config.fps}`
  if (encoder === 'h264_nvenc') {
    return `${grab},scale_d3d11=${config.width}:${config.height}:format=nv12`
  }
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
  const gop = opts.gop ?? 60
  const encoder = opts.encoder ?? 'h264_nvenc'
  const outputIdx = opts.outputIdx ?? 0
  const preset = opts.preset ?? 'p1'
  const bitrateKbps = opts.bitrateKbps ?? config.startBitrateKbps
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-filter_complex', filterChain(encoder, config, outputIdx),
    ...encoderArgs(encoder, gop, preset, bitrateKbps),
    '-bsf:v', 'dump_extra',
    '-f', 'h264',
    '-flush_packets', '1',
    'pipe:1'
  ]
}
