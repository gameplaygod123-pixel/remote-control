// Pure-Node entry point for the agent's native VIDEO SENDER helper.
//
// Spawned with ELECTRON_RUN_AS_NODE=1 by main/videoSenderHost.ts (same trick as
// the input helper: Electron's bundled Node, no Chromium). It owns the outbound
// H.264 RTP media track and the ffmpeg capture/encode child, and talks to the
// Electron main ONLY over the frozen IPC contract in ../shared/ipc.ts. The agent
// is the SDP offerer (unchanged from today).
//
// Unlike the input helper, this uses node-datachannel's RAW media API, not the
// polyfill -- the polyfill has no media tracks (proven in phase0/NOTES.md 0-A).
//
// All four Phase 1 risk items are wired here, per phase1/NOTES.md:
//   A keyframe-on-demand : parse incoming RTCP on the send track; PLI -> respawn
//                          ffmpeg for a fresh IDR (NACK handled by RtcpNackResponder).
//   B zero-latency       : ffmpeg low-latency flags live in ffmpegArgs.ts.
//   C RTP 90kHz stamps   : generated here from WALL-CLOCK capture time (ddagrab is
//                          on-change, so a fixed +90000/fps would drift).
//   D bitrate            : fixed CBR at config.startBitrateKbps; change = respawn.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PeerConnection,
  Video,
  RtpPacketizationConfig,
  H264RtpPacketizer,
  H265RtpPacketizer,
  RtcpSrReporter,
  RtcpNackResponder,
  initLogger,
  type Track,
  type LogLevel
} from 'node-datachannel'
import type { MainToVideoSender, VideoSenderToMain } from '../shared/ipc'
import type { NativeVideoStats, VideoCodec, VideoConfig } from '../shared/contract'
import {
  FfmpegFrameSource,
  CapturerFrameSource,
  SyntheticFrameSource,
  type FrameSource,
  type FrameSourceCallbacks
} from './frameSource'
import { NVENC_KEYFRAME_GOP } from './ffmpegArgs'
import { isKeyframeRequest, parseRtcpFeedback } from './rtcpFeedback'
import { logVideoSender } from '../../main/videoSenderLog'

// ── RTP / media constants (must match what the Mac receiver negotiates) ─────────
const PAYLOAD_TYPE = 96
const CLOCK_RATE = 90_000
const SSRC = 0x1234abcd
const CNAME = 'video-native'
const MAX_FRAGMENT = 1200 // MTU-safe FU-A fragment size (matches phase0 spike)
const STATS_INTERVAL_MS = 1_000

// Item A debounce (MUST FIX from Mac review). A forced IDR = an ffmpeg respawn,
// ~210-265ms with NO frames on the wire; during that gap the receiver still has no
// keyframe and (even rate-limited to <=1/s on the Mac side) can fire another PLI.
// Acting on it would stack a second respawn and never let recovery complete. So
// after forcing an IDR we IGNORE further PLIs for a cooldown longer than the worst
// respawn (265ms) -- one respawn is guaranteed to finish and deliver the keyframe
// before we'll honour another request. Agreed two-sided design: receiver <=1 PLI/s,
// sender cooldown >=300-500ms. 400ms sits comfortably above 265ms and below 1s.
const KEYFRAME_COOLDOWN_MS = 400

// Same verified STUN pair as the input helper (input-helper/index.ts): a single
// STUN server is a single point of failure, both of these are RFC 5389-verified.
// No unverified ICE servers -- golden rule #4.
const ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']

function log(message: string): void {
  logVideoSender('HELPER', message)
}

function send(msg: VideoSenderToMain): void {
  process.send?.(msg)
}

// node-datachannel's own (libdatachannel/libjuice) debug log -> our file log; a
// packaged helper has no console. Level tunable via NDC_LOG_LEVEL.
initLogger((process.env.NDC_LOG_LEVEL as LogLevel | undefined) ?? 'Warning', (level, message) => {
  log(`[ndc:${level}] ${message}`)
})

// ── ffmpeg resolution ───────────────────────────────────────────────────────
// Prefer an explicit path (dev / test), else the bundled binary under Electron's
// resources (packaged). The 160MB binary is NOT committed -- build-win.sh packs it
// (a Phase 1 ship task); until then set FFMPEG_PATH. VIDEO_FAKE_SOURCE=1 bypasses
// ffmpeg entirely for the ndc/RTP verification harness.
function resolveFfmpegPath(): string | null {
  const fromEnv = process.env.FFMPEG_PATH || process.env.FFMPEG
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const resDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resDir) {
    const bundled = join(resDir, 'ffmpeg', 'ffmpeg.exe')
    if (existsSync(bundled)) return bundled
  }
  return null
}

// ── quality-sweep knobs (env, opt-in) ────────────────────────────────────────
// Both default to the contract values (preset p1 / config.startBitrateKbps), so
// an unset env is byte-identical to before this knob existed. Set these at the
// real-ffmpeg run to sweep the Mac-approved p1→p4 / 20→30 Mbps range without a
// code change or re-review. VIDEO_NVENC_PRESET must be p1..p7 (else ignored).
function resolveFfmpegTuning(): { preset?: string; bitrateKbps?: number } {
  const tuning: { preset?: string; bitrateKbps?: number } = {}
  const preset = process.env.VIDEO_NVENC_PRESET
  if (preset && /^p[1-7]$/.test(preset)) tuning.preset = preset
  const br = Number(process.env.VIDEO_NVENC_BITRATE_KBPS)
  if (Number.isFinite(br) && br > 0) tuning.bitrateKbps = Math.round(br)
  return tuning
}

// ── Step 3: custom DXGI capturer (opt-in) ─────────────────────────────────────
// The capturer replaces ffmpeg/ddagrab with a change-detecting DXGI capturer
// (skips pointer-only frames -> Parsec-level GPU). OPT-IN (VIDEO_CAPTURER=1) and
// default OFF so a plain build is byte-identical to the ffmpeg path; if it's
// enabled but can't run (non-NVIDIA / missing / fails), we silently fall back to
// ffmpeg. Prefer an explicit path (dev), else the bundled binary under resources.
function capturerEnabled(): boolean {
  return process.env.VIDEO_CAPTURER === '1'
}

// ── Step: H.265 (HEVC) opt-in ─────────────────────────────────────────────────
// HEVC is ~1.6x more efficient than H.264 (Parsec runs 1440p60 HEVC at ~half the
// bitrate). OPT-IN via VIDEO_CODEC=hevc and default OFF so a plain agent is
// byte-identical H.264. The Mac receiver auto-detects the codec from the offer SDP
// (H265/90000 in the rtpmap), so nothing needs configuring on the controller. All
// three encode paths honour it coherently (capturer --codec h265, ffmpeg hevc_nvenc,
// -f hevc); the h264_mf fallback stays H.264 but hevc_nvenc never falls back to it
// (frameSource only MF-fallbacks the h264_nvenc encoder), so the SDP codec can never
// disagree with the bitstream. VideoToolbox on the Mac decodes HEVC in hardware.
function resolveCodec(config: VideoConfig): VideoCodec {
  return process.env.VIDEO_CODEC === 'hevc' ? 'hevc' : config.codec
}
function resolveCapturerPath(): string | null {
  const fromEnv = process.env.CAPTURER_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const resDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resDir) {
    const bundled = join(resDir, 'capturer', 'capturer.exe')
    if (existsSync(bundled)) return bundled
  }
  return null
}

// ── active session state ─────────────────────────────────────────────────────
interface Session {
  id: number
  pc: InstanceType<typeof PeerConnection>
  track: Track
  rtpConfig: InstanceType<typeof RtpPacketizationConfig>
  source: FrameSource | null
  config: VideoConfig
  /** performance.now() of the last honoured forceKeyframe -- PLI debounce (item A). */
  lastKeyframeAt: number
  firstCaptureMs: number
  framesInWindow: number
  bytesInWindow: number
  statsTimer: ReturnType<typeof setInterval> | undefined
}

let current: Session | null = null
let sessionCounter = 0

function closeSession(): void {
  if (!current) return
  const s = current
  current = null
  log(`closeSession id=${s.id}`)
  if (s.statsTimer) clearInterval(s.statsTimer)
  try {
    s.source?.stop()
  } catch (e) {
    log(`source.stop threw: ${(e as Error).message}`)
  }
  try {
    s.pc.close()
  } catch (e) {
    log(`pc.close threw: ${(e as Error).message}`)
  }
}

function startSession(rawConfig: VideoConfig): void {
  closeSession()
  sessionCounter += 1
  const id = sessionCounter
  // Resolve the codec (VIDEO_CODEC=hevc opt-in) once and thread it through the whole
  // session via config.codec: the RTP track/packetizer, capturer/ffmpeg args, the AU
  // assembler NAL layout, and the reported stats all read it, so they can't disagree.
  const config: VideoConfig = { ...rawConfig, codec: resolveCodec(rawConfig) }
  log(
    `startSession id=${id} ${config.width}x${config.height}@${config.fps} codec=${config.codec} startBr=${config.startBitrateKbps}kbps cursor=${config.cursor}`
  )

  const pc = new PeerConnection(`video-sender-${id}`, { iceServers: ICE_SERVERS })

  // SendOnly video track + SR reporter + NACK responder (auto-retransmit lost
  // packets from a send buffer, zero JS involvement -- item A first line of defence).
  // Codec-matched: an H.265 stream needs addH265Codec + H265RtpPacketizer (RFC 7798
  // payload format) or the receiver can't depacketize it. The rtpmap the receiver
  // sees in the offer (H264 vs H265) is what it auto-detects the codec from.
  const media = new Video('video', 'SendOnly')
  const hevc = config.codec === 'hevc'
  if (hevc) media.addH265Codec(PAYLOAD_TYPE)
  else media.addH264Codec(PAYLOAD_TYPE)
  media.addSSRC(SSRC, CNAME)
  const track = pc.addTrack(media)
  const rtpConfig = new RtpPacketizationConfig(SSRC, CNAME, PAYLOAD_TYPE, CLOCK_RATE)
  const packetizer = hevc
    ? new H265RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
    : new H264RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
  packetizer.addToChain(new RtcpSrReporter(rtpConfig))
  packetizer.addToChain(new RtcpNackResponder())
  track.setMediaHandler(packetizer)

  const session: Session = {
    id,
    pc,
    track,
    rtpConfig,
    source: null,
    config,
    lastKeyframeAt: 0,
    firstCaptureMs: 0,
    framesInWindow: 0,
    bytesInWindow: 0,
    statsTimer: undefined
  }
  current = session

  // ── signaling out (agent = offerer) ──
  pc.onLocalDescription((sdp, type) => {
    if (current !== session) return
    if (type === 'offer') {
      log(`offer ready (${sdp.length} bytes)`)
      send({ evt: 'offer', sdp })
    }
  })
  pc.onLocalCandidate((candidate, mid) => {
    if (current !== session) return
    // Raw ndc is mid-based (no sdpMLineIndex); the receiver adds by mid.
    send({ evt: 'ice', candidate, sdpMid: mid, sdpMLineIndex: null })
  })
  pc.onStateChange((state) => {
    if (current !== session) return
    log(`pc state=${state}`)
    // Controller went away for good. Tear the session down so ffmpeg stops
    // capturing -- otherwise ddagrab keeps a DXGI duplication open and NVENC
    // keeps an encode session busy with nobody watching (costly, and the box
    // shares NVENC's limited session count with Parsec). The host re-issues
    // start-session on the next pairing, so nothing is lost by stopping now.
    // Only terminal states: 'disconnected' can be a transient ICE blip that
    // recovers to 'connected', and killing capture then would drop the whole
    // stream instead of a brief freeze; libjuice progresses a real drop to
    // 'failed' on consent timeout, which we DO act on.
    if (state === 'failed' || state === 'closed') {
      log(`pc ${state} -> closing session (stop ffmpeg, free NVENC/DXGI)`)
      closeSession()
    }
  })

  // ── item A: incoming RTCP on the send track -> detect PLI -> force IDR ──
  // Debounced: coalesce PLIs that land within KEYFRAME_COOLDOWN_MS of a forced IDR
  // (the respawn hasn't delivered the keyframe yet, so a repeat is redundant and
  // stacking respawns would prevent recovery from ever completing).
  track.onMessage((msg: Buffer) => {
    if (current !== session) return
    const fb = parseRtcpFeedback(msg)
    if (!isKeyframeRequest(fb)) return
    const now = performance.now()
    const since = now - session.lastKeyframeAt
    if (session.lastKeyframeAt !== 0 && since < KEYFRAME_COOLDOWN_MS) {
      log(
        `RTCP keyframe request (pli=${fb.pli} fir=${fb.fir}) coalesced -- ${Math.round(since)}ms since last forced IDR (< ${KEYFRAME_COOLDOWN_MS}ms cooldown)`
      )
      return
    }
    session.lastKeyframeAt = now
    log(`RTCP keyframe request (pli=${fb.pli} fir=${fb.fir}) -> forcing IDR`)
    session.source?.forceKeyframe()
  })
  track.onError((err) => {
    if (current === session) log(`track error: ${err}`)
  })

  // ── frame source: start feeding the track once it opens ──
  track.onOpen(() => {
    if (current !== session) return
    log(`track open -> starting frame source`)
    startFrameSource(session)
    session.statsTimer = setInterval(() => reportStats(session), STATS_INTERVAL_MS)
  })

  pc.setLocalDescription() // begin negotiation as the offerer
}

function startFrameSource(session: Session): void {
  // Plain periodic IDR every 2s (NVENC_KEYFRAME_GOP = 120 @ 60fps). Step 1's
  // intra-refresh was reverted -- VideoToolbox can't decode the rolling-intra
  // P-frame structure (froze at every GOP length; WC, real hardware, beta.2/beta.3).
  // 2s halves v1.25.0's 1s (config.fps) keyframe-spike frequency and decodes fine.
  // Harmless to the MF fallback (its argv has no -g).
  const gop = NVENC_KEYFRAME_GOP
  const cb = {
    onAccessUnit: (au: { data: Buffer; keyframe: boolean }) => {
      if (current !== session) return
      const now = performance.now()
      if (!session.firstCaptureMs) session.firstCaptureMs = now
      // item C: wall-clock 90kHz timestamp (ddagrab is on-change, so +90000/fps drifts)
      session.rtpConfig.timestamp = Math.round((now - session.firstCaptureMs) * 90) >>> 0
      try {
        session.track.sendMessageBinary(au.data)
      } catch (e) {
        log(`sendMessageBinary threw: ${(e as Error).message}`)
        return
      }
      session.framesInWindow += 1
      session.bytesInWindow += au.data.length
    },
    onFatal: (message: string) => {
      if (current !== session) return
      log(`frame source fatal: ${message}`)
      send({ evt: 'fatal', message })
      closeSession()
      setImmediate(() => process.exit(1)) // clean respawn by the host
    },
    onLog: (line: string) => log(line)
  }

  if (process.env.VIDEO_FAKE_SOURCE === '1') {
    log('VIDEO_FAKE_SOURCE=1 -> synthetic frame source (no ffmpeg)')
    session.source = new SyntheticFrameSource(session.config, cb, session.config.fps)
    session.source.start()
    return
  }

  const startFfmpeg = (): void => {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath) {
      cb.onFatal('ffmpeg not found (set FFMPEG_PATH or bundle resources/ffmpeg/ffmpeg.exe)')
      return
    }
    log(`ffmpeg: ${ffmpegPath}`)
    const tuning = resolveFfmpegTuning()
    if (tuning.preset || tuning.bitrateKbps) {
      log(
        `quality-sweep override: preset=${tuning.preset ?? 'p1'} bitrateKbps=${tuning.bitrateKbps ?? session.config.startBitrateKbps}`
      )
    }
    // Codec-matched encoder so the ffmpeg fallback emits the same codec the SDP
    // negotiated. hevc_nvenc never MF-fallbacks (frameSource only MF-fallbacks
    // h264_nvenc), so it can't silently drop back to an H.264 bitstream.
    const encoder = session.config.codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc'
    session.source = new FfmpegFrameSource(ffmpegPath, session.config, gop, cb, encoder, tuning)
    session.source.start()
  }

  // Step 3: opt-in custom DXGI capturer with silent ffmpeg fallback (a capturer that
  // isn't present, or can't run, must never black-screen -- degrade to ffmpeg).
  if (capturerEnabled()) {
    const capturerPath = resolveCapturerPath()
    if (capturerPath) {
      log(`capturer: ${capturerPath}`)
      const tuning = resolveFfmpegTuning() // shares VIDEO_NVENC_BITRATE_KBPS sweep
      let fellBack = false
      const wrapped: FrameSourceCallbacks = {
        onAccessUnit: cb.onAccessUnit,
        onLog: cb.onLog,
        onFatal: (msg) => {
          if (fellBack || current !== session) return
          fellBack = true
          log(`capturer failed (${msg}) -> falling back to ffmpeg`)
          startFfmpeg()
        }
      }
      session.source = new CapturerFrameSource(capturerPath, session.config, gop, wrapped, {
        bitrateKbps: tuning.bitrateKbps
      })
      session.source.start()
      return
    }
    log('VIDEO_CAPTURER=1 but capturer.exe not found -> using ffmpeg')
  }
  startFfmpeg()
}

function reportStats(session: Session): void {
  if (current !== session) return
  const windowSec = STATS_INTERVAL_MS / 1000
  const stats: NativeVideoStats = {
    fps: Math.round(session.framesInWindow / windowSec),
    width: session.config.width,
    height: session.config.height,
    kbps: Math.round((session.bytesInWindow * 8) / 1000 / windowSec),
    captureMs: null, // ffmpeg exposes no per-frame capture/encode split (phase1 #4)
    // The capturer measures HW encode time (its `enc_ms=` stderr line, parsed in
    // CapturerFrameSource); ffmpeg/synthetic return null. Non-null => AgentView
    // forwards it to the Mac HUD's "Encode Xms".
    encodeMs: session.source?.getEncodeMs() ?? null,
    decodeMs: null, // receiver-side fields
    renderMs: null,
    rttMs: null,
    jitterMs: null, // receiver-side (frame-pacing jitter measured on arrival)
    codec: session.config.codec
  }
  session.framesInWindow = 0
  session.bytesInWindow = 0
  send({ evt: 'stats', stats })
}

// ── IPC in (MainToVideoSender) ────────────────────────────────────────────────
process.on('message', (raw: MainToVideoSender) => {
  switch (raw.cmd) {
    case 'start-session':
      startSession(raw.config)
      break
    case 'remote-answer':
      if (!current) {
        log('remote-answer with no active session -- ignored')
        break
      }
      log(`remote-answer (${raw.sdp.length} bytes)`)
      try {
        current.pc.setRemoteDescription(raw.sdp, 'answer')
      } catch (e) {
        log(`setRemoteDescription threw: ${(e as Error).message}`)
      }
      break
    case 'remote-ice':
      if (!current) {
        log('remote-ice with no active session -- ignored')
        break
      }
      try {
        current.pc.addRemoteCandidate(raw.candidate, raw.sdpMid ?? '')
      } catch (e) {
        log(`addRemoteCandidate threw: ${(e as Error).message}`)
      }
      break
    case 'set-bitrate':
      if (!current) {
        log('set-bitrate with no active session -- ignored')
        break
      }
      log(`set-bitrate ${raw.kbps}kbps -> forwarding to frame source`)
      current.source?.setBitrate(raw.kbps)
      break
    case 'stop-session':
      log('stop-session')
      closeSession()
      break
    case 'ping':
      send({ evt: 'pong' })
      break
  }
})

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err?.stack ?? err}`)
  send({ evt: 'fatal', message: err?.stack ?? String(err) })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason}`)
})

log('video sender helper booted')
send({ evt: 'ready' })
