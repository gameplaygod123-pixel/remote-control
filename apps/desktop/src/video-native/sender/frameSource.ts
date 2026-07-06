// The sender's frame source: produces H.264 access units for the RTP track.
//
// Two implementations behind one interface so the helper (index.ts) is agnostic:
//   - FfmpegFrameSource   : the production path -- spawns bundled ffmpeg
//     (ddagrab -> nvenc/mf -> Annex-B on pipe:1), splits NALs, assembles AUs.
//     forceKeyframe() = respawn ffmpeg (a fresh process starts with an IDR +
//     in-band SPS/PPS in ~210-265ms; phase1/NOTES #1.3). NVENC primary, MF
//     auto-fallback if NVENC never yields a frame (non-NVIDIA GPU).
//   - SyntheticFrameSource: no ffmpeg -- emits synthetic AUs at the target fps.
//     Used only to verify the whole ndc/RTP/PLI/stats path on a machine without
//     the (uncommitted, 160MB) ffmpeg binary present. Gated by the helper.

import { spawn, type ChildProcess } from 'node:child_process'
import type { VideoConfig } from '../shared/contract'
import { buildFfmpegArgs, type SenderEncoder } from './ffmpegArgs'
import { AccessUnitAssembler, NalSplitter, type AccessUnit } from './nalSplitter'

export interface FrameSourceCallbacks {
  onAccessUnit: (au: AccessUnit) => void
  /** Unrecoverable: the helper should report 'fatal' so the host respawns it. */
  onFatal: (message: string) => void
  /** Non-fatal diagnostic line (ffmpeg stderr / lifecycle), for logging. */
  onLog?: (line: string) => void
}

export interface FrameSource {
  start(): void
  /** Force a fresh IDR as soon as possible (answer to an RTCP PLI). */
  forceKeyframe(): void
  stop(): void
}

// If ffmpeg exits before EVER producing a frame and we're on NVENC, the GPU
// probably has no NVENC (non-NVIDIA) -> fall back to Media Foundation once.
export class FfmpegFrameSource implements FrameSource {
  private proc: ChildProcess | null = null
  private splitter = new NalSplitter()
  private assembler = new AccessUnitAssembler()
  private encoder: SenderEncoder
  private everProduced = false
  private triedMf = false
  private stopped = false
  private respawning = false

  constructor(
    private readonly ffmpegPath: string,
    private readonly config: VideoConfig,
    private readonly gop: number,
    private readonly cb: FrameSourceCallbacks,
    encoder: SenderEncoder = 'h264_nvenc'
  ) {
    this.encoder = encoder
  }

  start(): void {
    this.spawn()
  }

  forceKeyframe(): void {
    if (this.stopped) return
    this.cb.onLog?.('forceKeyframe -> respawning ffmpeg for a fresh IDR')
    this.respawn()
  }

  stop(): void {
    this.stopped = true
    this.kill()
  }

  private kill(): void {
    if (this.proc) {
      const p = this.proc
      this.proc = null
      p.removeAllListeners()
      try {
        p.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  private respawn(): void {
    this.respawning = true
    this.kill()
    this.splitter.reset()
    this.assembler.reset()
    this.spawn()
    this.respawning = false
  }

  private spawn(): void {
    if (this.stopped) return
    const args = buildFfmpegArgs(this.config, { gop: this.gop, encoder: this.encoder })
    this.cb.onLog?.(`spawn ffmpeg (${this.encoder}) ${this.config.width}x${this.config.height}@${this.config.fps} g=${this.gop}`)
    const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const nal of this.splitter.push(chunk)) {
        const au = this.assembler.push(nal)
        if (au) {
          this.everProduced = true
          this.cb.onAccessUnit(au)
        }
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) this.cb.onLog?.(`ffmpeg: ${line}`)
    })
    proc.on('error', (err) => {
      if (this.stopped || this.respawning) return
      this.cb.onFatal(`ffmpeg spawn error: ${err.message}`)
    })
    proc.on('exit', (code, signal) => {
      if (this.stopped || this.respawning || this.proc !== proc) return
      this.proc = null
      // Never produced a frame on NVENC -> assume no NVENC, fall back to MF once.
      if (!this.everProduced && this.encoder === 'h264_nvenc' && !this.triedMf) {
        this.triedMf = true
        this.encoder = 'h264_mf'
        this.cb.onLog?.('NVENC produced no frames -> falling back to h264_mf')
        this.splitter.reset()
        this.assembler.reset()
        this.spawn()
        return
      }
      this.cb.onFatal(`ffmpeg exited unexpectedly (code=${code} signal=${signal})`)
    })
  }
}

/**
 * ffmpeg-free source for verification. Emits synthetic Annex-B AUs at config.fps:
 * an IDR (fake SPS+PPS+IDR) every `idrEvery` frames, P-slices otherwise. Exercises
 * the exact packetize/RTP-timestamp/send path the real source feeds, so the
 * ndc media track + PLI feedback + stats can be proven without ffmpeg present.
 */
export class SyntheticFrameSource implements FrameSource {
  private timer: ReturnType<typeof setInterval> | undefined
  private frame = 0
  private forceIdr = false
  private readonly idrEvery: number

  constructor(
    private readonly config: VideoConfig,
    private readonly cb: FrameSourceCallbacks,
    idrEvery = 60,
    private readonly idrBytes = 20_000,
    private readonly pBytes = 8_000
  ) {
    this.idrEvery = idrEvery
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 1000 / this.config.fps)
  }

  forceKeyframe(): void {
    this.forceIdr = true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private startCode(b: Buffer, off: number, nalHeader: number): void {
    b[off] = 0
    b[off + 1] = 0
    b[off + 2] = 0
    b[off + 3] = 1
    b[off + 4] = nalHeader
  }

  private tick(): void {
    const isIdr = this.forceIdr || this.frame % this.idrEvery === 0
    this.forceIdr = false
    this.frame++
    if (isIdr) {
      // SPS(7) + PPS(8) + IDR(5), each a tiny stub -- transport/framing test only.
      const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f])
      const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80])
      const idr = Buffer.alloc(this.idrBytes)
      this.startCode(idr, 0, 0x65)
      idr.fill(0xab, 5)
      this.cb.onAccessUnit({ data: Buffer.concat([sps, pps, idr]), keyframe: true })
    } else {
      const p = Buffer.alloc(this.pBytes)
      this.startCode(p, 0, 0x41)
      p.fill(0xcd, 5)
      this.cb.onAccessUnit({ data: p, keyframe: false })
    }
  }
}
