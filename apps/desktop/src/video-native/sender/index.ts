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
  RtcpSrReporter,
  RtcpNackResponder,
  initLogger,
  type Track,
  type LogLevel
} from 'node-datachannel'
import type { MainToVideoSender, VideoSenderToMain } from '../shared/ipc'
import type { NativeVideoStats, VideoConfig } from '../shared/contract'
import { FfmpegFrameSource, SyntheticFrameSource, type FrameSource } from './frameSource'
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

function startSession(config: VideoConfig): void {
  closeSession()
  sessionCounter += 1
  const id = sessionCounter
  log(`startSession id=${id} ${config.width}x${config.height}@${config.fps} codec=${config.codec} startBr=${config.startBitrateKbps}kbps cursor=${config.cursor}`)

  const pc = new PeerConnection(`video-sender-${id}`, { iceServers: ICE_SERVERS })

  // SendOnly H.264 track + SR reporter + NACK responder (auto-retransmit lost
  // packets from a send buffer, zero JS involvement -- item A first line of defence).
  const media = new Video('video', 'SendOnly')
  media.addH264Codec(PAYLOAD_TYPE)
  media.addSSRC(SSRC, CNAME)
  const track = pc.addTrack(media)
  const rtpConfig = new RtpPacketizationConfig(SSRC, CNAME, PAYLOAD_TYPE, CLOCK_RATE)
  const packetizer = new H264RtpPacketizer('LongStartSequence', rtpConfig, MAX_FRAGMENT)
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
    if (current === session) log(`pc state=${state}`)
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
      log(`RTCP keyframe request (pli=${fb.pli} fir=${fb.fir}) coalesced -- ${Math.round(since)}ms since last forced IDR (< ${KEYFRAME_COOLDOWN_MS}ms cooldown)`)
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
  const gop = session.config.fps // 1s GOP (item A.2: cheap self-heal under CBR)
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
  } else {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath) {
      cb.onFatal('ffmpeg not found (set FFMPEG_PATH or bundle resources/ffmpeg/ffmpeg.exe)')
      return
    }
    log(`ffmpeg: ${ffmpegPath}`)
    session.source = new FfmpegFrameSource(ffmpegPath, session.config, gop, cb)
  }
  session.source.start()
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
    encodeMs: null,
    decodeMs: null, // receiver-side fields
    renderMs: null,
    rttMs: null,
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
