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
import { buildCapturerArgs, type CapturerArgOptions } from './capturerArgs'
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
  /** BWE: set a new VBR target (kbps) live. The capturer retunes NVENC in place
   *  (no respawn); other sources that can't retune live no-op. */
  setBitrate(kbps: number): void
  /** Latest per-frame HW encode time (ms) if the source measures it, else null.
   *  Only the capturer reports it (parsed from its `enc_ms=` stderr); ffmpeg
   *  exposes no capture/encode split, synthetic has none. Feeds the HUD's
   *  "Encode Xms" (NativeVideoStats.encodeMs). */
  getEncodeMs(): number | null
  stop(): void
}

/** Optional quality-sweep overrides for the ffmpeg encoder (see ffmpegArgs.ts).
 *  Both default to the contract values (p1 / config.startBitrateKbps) when omitted,
 *  so the production default is byte-identical to before this knob existed. */
export interface FfmpegTuning {
  preset?: string
  bitrateKbps?: number
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
  // Auto-recovery from a MID-STREAM ffmpeg death (the common one is ddagrab losing
  // DXGI Desktop Duplication -- DXGI_ERROR_ACCESS_LOST 0x887a0026 -- on a desktop/
  // mode switch or another capturer grabbing the desktop). We restart ffmpeg IN
  // PLACE instead of failing the helper, so the peer connection survives (a full
  // re-pair froze video+input for seconds = the "mouse dead" symptom). Guarded by
  // a crash-loop limit so a genuinely broken ffmpeg still escalates to onFatal.
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private crashTimes: number[] = []
  private static readonly RESTART_DELAY_MS = 300
  private static readonly CRASH_WINDOW_MS = 10_000
  private static readonly MAX_CRASHES_IN_WINDOW = 5

  constructor(
    private readonly ffmpegPath: string,
    private readonly config: VideoConfig,
    private readonly gop: number,
    private readonly cb: FrameSourceCallbacks,
    encoder: SenderEncoder = 'h264_nvenc',
    private readonly tuning: FfmpegTuning = {}
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

  setBitrate(kbps: number): void {
    // ffmpeg/ddagrab can't be reconfigured live (a bitrate change = a respawn, too
    // disruptive for BWE's ~1s cadence). BWE is a capturer-path feature; on the
    // ffmpeg fallback we log and hold the fixed rate rather than churn the encoder.
    this.cb.onLog?.(`setBitrate(${kbps}) ignored -- ffmpeg source can't retune live`)
  }

  getEncodeMs(): number | null {
    // ffmpeg exposes no per-frame capture/encode split (phase1 #4).
    return null
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
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
    // A fresh spawn supersedes any pending auto-restart (e.g. forceKeyframe raced
    // the restart timer) -- clear it so we never double-spawn.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const args = buildFfmpegArgs(this.config, {
      gop: this.gop,
      encoder: this.encoder,
      preset: this.tuning.preset,
      bitrateKbps: this.tuning.bitrateKbps
    })
    const brk = this.tuning.bitrateKbps ?? this.config.startBitrateKbps
    const preset = this.tuning.preset ?? 'p1'
    this.cb.onLog?.(`spawn ffmpeg (${this.encoder}) ${this.config.width}x${this.config.height}@${this.config.fps} g=${this.gop} preset=${preset} ${brk}k`)
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
      // Died AFTER streaming -> almost always a recoverable capture loss (ddagrab
      // DXGI_ERROR_ACCESS_LOST). Restart ffmpeg in place (fresh IDR + in-band
      // SPS/PPS) WITHOUT tearing down the session -- unless it's crash-looping.
      if (this.everProduced) {
        const now = Date.now()
        this.crashTimes = this.crashTimes.filter(
          (t) => now - t < FfmpegFrameSource.CRASH_WINDOW_MS
        )
        this.crashTimes.push(now)
        if (this.crashTimes.length > FfmpegFrameSource.MAX_CRASHES_IN_WINDOW) {
          this.cb.onFatal(
            `ffmpeg crash-looping (${this.crashTimes.length} exits in ` +
              `${FfmpegFrameSource.CRASH_WINDOW_MS}ms, code=${code} signal=${signal})`
          )
          return
        }
        this.cb.onLog?.(
          `ffmpeg exited mid-stream (code=${code} signal=${signal}) -- likely ddagrab ` +
            `ACCESS_LOST; restarting capture in ${FfmpegFrameSource.RESTART_DELAY_MS}ms ` +
            `(${this.crashTimes.length}/${FfmpegFrameSource.MAX_CRASHES_IN_WINDOW})`
        )
        this.splitter.reset()
        this.assembler.reset()
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined
          this.spawn()
        }, FfmpegFrameSource.RESTART_DELAY_MS)
        return
      }
      this.cb.onFatal(`ffmpeg exited unexpectedly (code=${code} signal=${signal})`)
    })
  }
}

/**
 * Step 3 (custom DXGI capturer) source: spawns our `capturer.exe`, which does DXGI
 * Desktop Duplication + change-detection + NVENC and writes the SAME Annex-B stream
 * to stdout that ffmpeg does (so NalSplitter/AccessUnitAssembler/RTP are unchanged).
 * The win over FfmpegFrameSource: change-detection skips unchanged AND pointer-only
 * frames, so a static screen with the mouse moving encodes ~0 frames (Parsec-level
 * GPU) — the thing ddagrab structurally can't do.
 *
 * Differences from FfmpegFrameSource:
 *  - forceKeyframe() writes a single byte 'I' to the capturer's stdin (the 3c
 *    contract) → a fresh IDR at the next frame, WITHOUT respawning. This is the
 *    cheap PLI recovery ffmpeg couldn't do (it had to respawn ~210ms).
 *  - No MF fallback: the capturer is NVENC-only. If it can't run (non-NVIDIA /
 *    missing / broken) the choice at the call site should be ffmpeg instead; here a
 *    never-produced exit or spawn error is fatal.
 *  - ACCESS_LOST is recovered INSIDE capturer.exe (it doesn't exit), so mid-stream
 *    exits should be rare; if one happens after streaming we still restart in place
 *    (same crash-loop-guarded logic as ffmpeg) as a belt-and-braces.
 */
export class CapturerFrameSource implements FrameSource {
  private proc: ChildProcess | null = null
  private splitter = new NalSplitter()
  private assembler = new AccessUnitAssembler()
  private everProduced = false
  private stopped = false
  private respawning = false
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private crashTimes: number[] = []
  // Latest avg per-frame HW encode time (ms), parsed from the capturer's per-second
  // `enc_ms=` stderr line. null until the first line arrives; held across idle windows
  // (the capturer reports 0.0 when nothing encoded — we keep the last real value so the
  // HUD shows the true encode cost instead of flickering to 0 on a static screen).
  private lastEncodeMs: number | null = null
  private static readonly RESTART_DELAY_MS = 300
  private static readonly CRASH_WINDOW_MS = 10_000
  private static readonly MAX_CRASHES_IN_WINDOW = 5

  constructor(
    private readonly capturerPath: string,
    private readonly config: VideoConfig,
    private readonly gop: number,
    private readonly cb: FrameSourceCallbacks,
    private readonly tuning: CapturerArgOptions = {}
  ) {}

  start(): void {
    this.spawn()
  }

  forceKeyframe(): void {
    if (this.stopped) return
    // The cheap PLI recovery: ask capturer.exe for an IDR via stdin — no respawn.
    const proc = this.proc
    if (proc?.stdin?.writable) {
      try {
        proc.stdin.write('I')
        this.cb.onLog?.('forceKeyframe -> sent I to capturer stdin')
        return
      } catch {
        /* fall through to respawn if the pipe is wedged */
      }
    }
    this.cb.onLog?.('forceKeyframe -> capturer stdin unavailable; respawning')
    this.respawn()
  }

  setBitrate(kbps: number): void {
    if (this.stopped) return
    // BWE live retune: 'B'<ascii-kbps>'\n' -> capturer runs nvEncReconfigureEncoder
    // in place (no respawn, no forced IDR). Same stdin control channel as 'I'.
    const rounded = Math.round(kbps)
    if (!Number.isFinite(rounded) || rounded <= 0) return
    const proc = this.proc
    if (proc?.stdin?.writable) {
      try {
        proc.stdin.write(`B${rounded}\n`)
        this.cb.onLog?.(`setBitrate -> sent B${rounded} to capturer stdin`)
        return
      } catch {
        /* pipe wedged; drop this update -- the next one will retry */
      }
    }
    this.cb.onLog?.(`setBitrate(${rounded}) skipped -- capturer stdin unavailable`)
  }

  getEncodeMs(): number | null {
    return this.lastEncodeMs
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
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
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const args = buildCapturerArgs(this.config, {
      output: 'stdout',
      gop: this.gop,
      outputIdx: this.tuning.outputIdx,
      bitrateKbps: this.tuning.bitrateKbps,
      maxBitrateKbps: this.tuning.maxBitrateKbps
    })
    const brk = this.tuning.bitrateKbps ?? this.config.startBitrateKbps
    this.cb.onLog?.(
      `spawn capturer ${this.config.width}x${this.config.height}@${this.config.fps} g=${this.gop} ${brk}k`
    )
    // stdin piped so forceKeyframe() can send 'I'; a closed stdin = the contract's
    // shutdown signal, so keep it open for the process lifetime.
    const proc = spawn(this.capturerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
      if (!line) return
      // The per-second locked-cadence log carries `enc_ms=<avg>` — the HW encode time.
      // Keep the last REAL value (>0); the capturer emits 0.0 on an idle window (nothing
      // encoded), which isn't a measured encode time, so don't let it clobber the HUD.
      const m = line.match(/enc_ms=([\d.]+)/)
      if (m) {
        const v = Number.parseFloat(m[1])
        if (Number.isFinite(v) && v > 0) this.lastEncodeMs = v
      }
      this.cb.onLog?.(`capturer: ${line}`)
    })
    // Ignore EPIPE on stdin if the capturer has already exited.
    proc.stdin!.on('error', () => {
      /* capturer gone; the exit handler deals with recovery */
    })
    proc.on('error', (err) => {
      if (this.stopped || this.respawning) return
      this.cb.onFatal(`capturer spawn error: ${err.message}`)
    })
    proc.on('exit', (code, signal) => {
      if (this.stopped || this.respawning || this.proc !== proc) return
      this.proc = null
      // Never produced a frame -> the capturer can't run here (no NVENC / broken).
      // Unlike ffmpeg there's no MF fallback; escalate so the call site can choose
      // the ffmpeg path instead.
      if (!this.everProduced) {
        this.cb.onFatal(`capturer produced no frames (code=${code} signal=${signal})`)
        return
      }
      // Died AFTER streaming. capturer.exe recovers ACCESS_LOST internally, so this
      // is unexpected; restart in place (fresh IDR) unless it's crash-looping.
      const now = Date.now()
      this.crashTimes = this.crashTimes.filter(
        (t) => now - t < CapturerFrameSource.CRASH_WINDOW_MS
      )
      this.crashTimes.push(now)
      if (this.crashTimes.length > CapturerFrameSource.MAX_CRASHES_IN_WINDOW) {
        this.cb.onFatal(
          `capturer crash-looping (${this.crashTimes.length} exits in ` +
            `${CapturerFrameSource.CRASH_WINDOW_MS}ms, code=${code} signal=${signal})`
        )
        return
      }
      this.cb.onLog?.(
        `capturer exited mid-stream (code=${code} signal=${signal}); restarting in ` +
          `${CapturerFrameSource.RESTART_DELAY_MS}ms ` +
          `(${this.crashTimes.length}/${CapturerFrameSource.MAX_CRASHES_IN_WINDOW})`
      )
      this.splitter.reset()
      this.assembler.reset()
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        this.spawn()
      }, CapturerFrameSource.RESTART_DELAY_MS)
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

  setBitrate(): void {
    /* synthetic source emits fixed-size frames; nothing to retune */
  }

  getEncodeMs(): number | null {
    /* no real encoder -> no encode time */
    return null
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
