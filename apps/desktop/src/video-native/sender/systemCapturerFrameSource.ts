// SECURE-DESKTOP frame source (docs/secure-desktop-plan.md Part 2). Unlike
// CapturerFrameSource (which spawns capturer.exe as its own child in the user
// session), this source can't spawn the capturer itself — the capturer must run as
// SYSTEM to follow the desktop into Winlogon (UAC / lock / Ctrl+Alt+Del), which only
// the Track 2 SYSTEM launcher can do. So the roles invert:
//
//   1. This source (user session, medium integrity) HOSTS two named pipes:
//        - a REQUEST pipe (frozen name) — it writes ONE spawn-request frame; the
//          SYSTEM launcher connects on its ~2s tick, reads it, and spawns
//          capturer.exe --output pipe:<videoPipe> as SYSTEM-in-session.
//        - a VIDEO pipe (unique per session) — the SYSTEM capturer connects back and
//          writes the SAME Annex-B stream stdout carried, and READS control bytes
//          (I / B<kbps> / L) off the same duplex pipe.
//   2. Fix A (proven for the Track 2 input pipe, shipped v1.23.0): the MEDIUM side
//      HOSTS and SYSTEM CONNECTS — a SYSTEM-hosted pipe's default DACL would deny the
//      medium sender. Verified for input; this is its first use for video.
//   3. No-orphan: the capturer isn't our child, so it has no parent-death signal —
//      closing the VIDEO pipe (stop / crash) makes it hit a broken pipe and exit 0.
//
// If no capturer connects within the timeout (launcher not installed / disabled /
// GPU issue), we call onUnavailable — the caller falls back to the in-session
// CapturerFrameSource so the normal desktop can never black-screen because of this.

import net from 'node:net'
import { randomBytes } from 'node:crypto'
import type { VideoConfig } from '../shared/contract'
import { buildCapturerSpawnRequest, type CapturerArgOptions } from './capturerArgs'
import { AccessUnitAssembler, NalSplitter } from './nalSplitter'
import type { FrameSource, FrameSourceCallbacks } from './frameSource'

// The request pipe name is FROZEN and must match the launcher (service.ts).
// See docs/secure-desktop-plan.md "2b spawn-trigger contract".
export const CAPTURER_SPAWN_PIPE = '\\\\.\\pipe\\personal-remote-capturer-spawn'

export interface SystemCapturerCallbacks extends FrameSourceCallbacks {
  /** The SYSTEM capturer path can't be used (pipe host failed, or no capturer
   *  connected within the timeout). Distinct from onFatal (which tears the helper
   *  down): the caller should GRACEFULLY fall back to the in-session
   *  CapturerFrameSource. Called at most once. */
  onUnavailable: (reason: string) => void
}

export interface SystemCapturerOptions extends CapturerArgOptions {
  /** How long to wait for the SYSTEM capturer to connect the video pipe before
   *  declaring the path unavailable and falling back. Default 10s. */
  connectTimeoutMs?: number
  /** Override the video pipe name (tests). Default: unique per process. */
  videoPipeName?: string
  /** Override the request pipe name (tests). Default: the frozen CAPTURER_SPAWN_PIPE. */
  requestPipeName?: string
}

// Wire framing for the request pipe: 4-byte LE length + UTF-8 JSON. This MUST match
// input-service/protocol.ts encodeFrame's format byte-for-byte (the launcher decodes
// it with that FrameDecoder). Inlined rather than importing encodeFrame because that
// helper is typed to RemoteInputMessage; the wire format, not the type, is the contract.
function encodeRequestFrame(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const frame = Buffer.allocUnsafe(4 + json.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  return frame
}

export class SystemCapturerFrameSource implements FrameSource {
  private videoServer: net.Server | null = null
  private requestServer: net.Server | null = null
  private client: net.Socket | null = null // the connected capturer's video pipe
  private splitter = new NalSplitter()
  private assembler: AccessUnitAssembler
  private readonly videoPipeName: string
  private readonly requestPipeName: string
  private readonly connectTimeoutMs: number
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private everProduced = false
  // We hand the launcher exactly ONE request frame per desired (re)spawn, so a
  // continuously-polling launcher can't spawn a second capturer. Re-armed if the
  // capturer connection is lost and we want a fresh spawn.
  private requestPending = true
  private crashTimes: number[] = []
  private static readonly CRASH_WINDOW_MS = 10_000
  private static readonly MAX_CRASHES_IN_WINDOW = 5

  constructor(
    private readonly config: VideoConfig,
    private readonly gop: number,
    private readonly cb: SystemCapturerCallbacks,
    private readonly opts: SystemCapturerOptions = {}
  ) {
    this.assembler = new AccessUnitAssembler(config.codec)
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000
    this.requestPipeName = opts.requestPipeName ?? CAPTURER_SPAWN_PIPE
    // Unique per session; MUST satisfy the launcher's allow-regex
    // ^\\.\pipe\pr-capturer-[A-Za-z0-9._-]+$ (see the frozen contract).
    this.videoPipeName =
      opts.videoPipeName ??
      `\\\\.\\pipe\\pr-capturer-${process.pid}-${randomBytes(4).toString('hex')}`
  }

  start(): void {
    if (this.stopped) return
    this.hostVideoPipe()
    this.hostRequestPipe()
    // Fall back if the SYSTEM capturer never shows up (launcher absent/disabled).
    this.connectTimer = setTimeout(() => {
      if (this.stopped || this.everProduced) return
      this.unavailable(`no SYSTEM capturer connected within ${this.connectTimeoutMs}ms`)
    }, this.connectTimeoutMs)
  }

  private hostVideoPipe(): void {
    const server = net.createServer((socket) => {
      // The SYSTEM capturer connected. Only one is expected; ignore extras.
      if (this.client) {
        socket.destroy()
        return
      }
      this.client = socket
      this.cb.onLog?.('system-capturer: video pipe connected')
      socket.on('data', (chunk: Buffer) => {
        for (const nal of this.splitter.push(chunk)) {
          const au = this.assembler.push(nal)
          if (au) {
            this.everProduced = true
            this.cb.onAccessUnit(au)
          }
        }
      })
      socket.on('error', () => {
        /* broken pipe on teardown — handled by 'close' */
      })
      socket.on('close', () => this.onClientClosed())
    })
    server.on('error', (e) =>
      this.unavailable(`cannot host video pipe ${this.videoPipeName}: ${(e as Error).message}`)
    )
    server.listen(this.videoPipeName, () => {
      this.cb.onLog?.(`system-capturer: hosting video pipe ${this.videoPipeName}`)
    })
    this.videoServer = server
  }

  private hostRequestPipe(): void {
    // Written EARLY (parallel with ICE) so the launcher's ~2s poll overlaps
    // negotiation rather than adding to first-frame latency. Kept hosted for the
    // whole session so a slow poll can't miss the request via a write-then-close race.
    const request = buildCapturerSpawnRequest(this.config, this.videoPipeName, {
      outputIdx: this.opts.outputIdx,
      gop: this.gop,
      bitrateKbps: this.opts.bitrateKbps,
      maxBitrateKbps: this.opts.maxBitrateKbps,
      vbvMs: this.opts.vbvMs
    })
    const frame = encodeRequestFrame(request)
    const server = net.createServer((socket) => {
      // The launcher connected on its tick. Offer the request only when one is
      // pending, so a continuously-polling launcher spawns exactly one capturer.
      if (this.requestPending) {
        this.requestPending = false
        socket.end(frame)
        this.cb.onLog?.(`system-capturer: sent spawn request (video pipe ${this.videoPipeName})`)
      } else {
        socket.end()
      }
    })
    server.on('error', (e) =>
      this.unavailable(`cannot host request pipe ${this.requestPipeName}: ${(e as Error).message}`)
    )
    server.listen(this.requestPipeName, () => {
      this.cb.onLog?.(`system-capturer: hosting request pipe ${this.requestPipeName}`)
    })
    this.requestServer = server
  }

  private onClientClosed(): void {
    if (this.stopped || this.client === null) return
    this.client = null
    if (!this.everProduced) return // the connect-timeout path handles never-produced
    // The capturer normally recovers ACCESS_LOST internally, so a dropped video pipe
    // after streaming is unexpected. Re-arm the request so the polling launcher
    // re-spawns, unless it's crash-looping.
    const now = Date.now()
    this.crashTimes = this.crashTimes.filter(
      (t) => now - t < SystemCapturerFrameSource.CRASH_WINDOW_MS
    )
    this.crashTimes.push(now)
    if (this.crashTimes.length > SystemCapturerFrameSource.MAX_CRASHES_IN_WINDOW) {
      this.cb.onFatal(
        `system capturer crash-looping (${this.crashTimes.length} in ` +
          `${SystemCapturerFrameSource.CRASH_WINDOW_MS}ms)`
      )
      return
    }
    this.cb.onLog?.('system-capturer: video pipe lost mid-stream; re-arming spawn request')
    this.splitter.reset()
    this.assembler.reset()
    this.requestPending = true
  }

  /** Send a control byte/string to the capturer over the duplex video pipe (== stdin
   *  in the child path). No-op if the capturer hasn't connected yet. */
  private sendControl(data: string, label: string): boolean {
    const sock = this.client
    if (sock && sock.writable) {
      try {
        sock.write(data)
        this.cb.onLog?.(`system-capturer: ${label}`)
        return true
      } catch {
        /* pipe wedged; drop */
      }
    }
    return false
  }

  forceKeyframe(): void {
    if (this.stopped) return
    if (!this.sendControl('I', 'forceKeyframe -> sent I')) {
      this.cb.onLog?.('system-capturer: forceKeyframe dropped (no capturer connected)')
    }
  }

  ltrRecover(): void {
    if (this.stopped) return
    if (!this.sendControl('L', 'ltrRecover -> sent L')) this.forceKeyframe()
  }

  setBitrate(kbps: number): void {
    if (this.stopped) return
    const rounded = Math.round(kbps)
    if (!Number.isFinite(rounded) || rounded <= 0) return
    this.sendControl(`B${rounded}\n`, `setBitrate -> sent B${rounded}`)
  }

  getEncodeMs(): number | null {
    // The SYSTEM capturer's stderr (which carries enc_ms=) goes to the launcher's log
    // file, not to us — the pipe is the pure video stream. So no HUD Encode number on
    // this path (acceptable for the special secure-desktop mode; a stats sideband is
    // possible 2d polish).
    return null
  }

  private unavailable(reason: string): void {
    if (this.stopped) return
    this.cb.onLog?.(`system-capturer: unavailable — ${reason}`)
    this.teardown()
    this.cb.onUnavailable(reason)
  }

  private teardown(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }
    // Closing the video pipe = the capturer's broken-pipe death signal (no-orphan).
    this.client?.destroy()
    this.client = null
    this.videoServer?.close()
    this.videoServer = null
    this.requestServer?.close()
    this.requestServer = null
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.teardown()
  }
}
