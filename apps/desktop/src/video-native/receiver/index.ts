// Pure-Node entry point for the Mac controller's native VIDEO RECEIVER helper.
//
// Spawned with ELECTRON_RUN_AS_NODE=1 by main/videoReceiverHost.ts (same trick as
// the input helper / video sender). It answers the agent's native offer on
// channel:'video-native', receives the H.264 RTP track via node-datachannel, and
// reassembles Annex-B access units (ndc has no H.264 depacketizer -- see
// rtpDepacketizer.ts). It then hands each AU back to Electron MAIN (evt:'au'),
// which pushes it into the in-process render surface (librvr.dylib) so the video
// composites INSIDE the Electron window -- NO separate Swift render process/window
// (native-video-plan §3a fix). The agent is the SDP offerer (unchanged); we
// ANSWER. Talks to Electron main ONLY over the frozen IPC contract in
// ../shared/ipc.ts.
//
// This is the inverse of sender/index.ts and shares its shape (raw ndc media API,
// wall-clock-free since we only consume, RtcpReceivingSession for RTCP + the
// track.requestKeyframe() PLI the sender's item-A recovery listens for).

import {
  PeerConnection,
  RtcpReceivingSession,
  initLogger,
  type Track,
  type LogLevel
} from 'node-datachannel'
import type { MainToVideoReceiver, VideoReceiverToMain } from '../shared/ipc'
import type { NativeVideoStats, VideoCodec } from '../shared/contract'
import { RtpDepacketizer, createDepacketizer, isRtcp } from './rtpDepacketizer'
import { videoDimensions } from './spsDimensions'
import { BandwidthEstimator } from './bwe'
import { logVideoReceiver } from '../../main/videoReceiverLog'

// Must match the sender (sender/index.ts): same STUN pair (golden rule #4), same
// verified servers -- a single STUN server is a single point of failure.
const ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
const STATS_INTERVAL_MS = 1_000
// Rate-limit our PLI to the agreed <=1/s (two-sided design: sender debounces
// forced IDRs at 400ms, receiver never storms it) -- see sender/index.ts item A.
const KEYFRAME_REQUEST_COOLDOWN_MS = 1_000

function log(message: string): void {
  logVideoReceiver('HELPER', message)
}
function send(msg: VideoReceiverToMain): void {
  process.send?.(msg)
}

initLogger((process.env.NDC_LOG_LEVEL as LogLevel | undefined) ?? 'Warning', (level, message) => {
  log(`[ndc:${level}] ${message}`)
})

interface Session {
  id: number
  pc: InstanceType<typeof PeerConnection>
  track: Track | null
  // Codec is auto-detected from the offer SDP (H264 default; H265 when the agent
  // opted into VIDEO_CODEC=hevc). Drives the depacketizer payload format, the SPS
  // dimension parser, and the codec reported to main (which sets the Swift decoder).
  codec: VideoCodec
  depacketizer: RtpDepacketizer
  // Loss-based AIMD bitrate estimator (feeds the sender's live bitrate over
  // signaling via evt:'bitrate'). Media-only pc has no built-in BWE -- see bwe.ts.
  bwe: BandwidthEstimator
  firstFrameSeen: boolean
  lastKeyframeRequestAt: number
  framesInWindow: number
  bytesInWindow: number
  // Frame-pacing jitter: how evenly reassembled AUs land (perceived smoothness).
  // RFC3550-style smoothed deviation of the inter-arrival interval from its
  // running mean, in ms -- purely receiver-side (no clock sync needed).
  lastAuArrivalMs: number
  meanIntervalMs: number
  jitterMs: number
  statsTimer: ReturnType<typeof setInterval> | undefined
  lastStats: Partial<NativeVideoStats>
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
    s.pc.close()
  } catch (e) {
    log(`pc.close threw: ${(e as Error).message}`)
  }
}

function requestKeyframe(s: Session, reason: string): void {
  if (!s.track) return
  const now = performance.now()
  if (
    s.lastKeyframeRequestAt !== 0 &&
    now - s.lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS
  ) {
    return // rate-limited to <=1/s so we never storm the sender
  }
  s.lastKeyframeRequestAt = now
  log(`requestKeyframe (${reason}) -> PLI`)
  try {
    s.track.requestKeyframe()
  } catch (e) {
    log(`requestKeyframe threw: ${(e as Error).message}`)
  }
}

// Hand one reassembled Annex-B access unit to Electron main; it pushes it into
// the in-process render surface (librvr.dylib). Sent over the 'advanced'-
// serialized fork channel so the Buffer transfers efficiently at 60fps.
function feedRender(s: Session, au: Buffer): void {
  if (current !== s) return
  send({ evt: 'au', data: au })
  if (!s.firstFrameSeen) {
    s.firstFrameSeen = true
    log('first AU forwarded to main render surface')
    send({ evt: 'first-frame' })
  }
}

function startSession(): void {
  closeSession()
  sessionCounter += 1
  const id = sessionCounter
  log(`startSession id=${id}`)

  const pc = new PeerConnection(`video-receiver-${id}`, { iceServers: ICE_SERVERS })
  const session: Session = {
    id,
    pc,
    track: null,
    codec: 'h264',
    depacketizer: createDepacketizer('h264'),
    bwe: new BandwidthEstimator(),
    firstFrameSeen: false,
    lastKeyframeRequestAt: 0,
    framesInWindow: 0,
    bytesInWindow: 0,
    lastAuArrivalMs: 0,
    meanIntervalMs: 0,
    jitterMs: 0,
    statsTimer: undefined,
    lastStats: {}
  }
  current = session

  // We ANSWER: ndc generates the answer when we setRemoteDescription(offer).
  pc.onLocalDescription((sdp, type) => {
    if (current !== session) return
    if (type === 'answer') {
      log(`answer ready (${sdp.length} bytes)`)
      send({ evt: 'answer', sdp })
    }
  })
  pc.onLocalCandidate((candidate, mid) => {
    if (current !== session) return
    send({ evt: 'ice', candidate, sdpMid: mid, sdpMLineIndex: null })
  })
  pc.onStateChange((state) => {
    if (current === session) log(`pc state=${state}`)
  })

  // The agent's offer carries a SendOnly video track; ndc surfaces it here.
  pc.onTrack((track) => {
    if (current !== session) return
    log('onTrack -- incoming video-native track')
    session.track = track
    track.setMediaHandler(new RtcpReceivingSession())

    track.onOpen(() => {
      if (current !== session) return
      log('track open -> requesting initial keyframe')
      requestKeyframe(session, 'session start')
      session.statsTimer = setInterval(() => reportStats(session), STATS_INTERVAL_MS)
    })
    track.onMessage((msg: Buffer) => {
      if (current !== session) return
      if (isRtcp(msg)) return // RTCP (e.g. sender reports) -- ndc handles it
      // Feed the RTP sequence number (bytes 2-3) to the BWE estimator BEFORE
      // depacketizing -- loss is a per-packet signal, independent of AU reassembly.
      if (msg.length >= 4) session.bwe.observe(msg.readUInt16BE(2))
      for (const au of session.depacketizer.push(msg)) {
        session.framesInWindow += 1
        session.bytesInWindow += au.data.length
        // Read the real resolution off the in-band SPS once (the first AU is an
        // IDR with parameter sets); ndc/VideoToolbox never surface it to Node.
        if (!session.lastStats.width) {
          const dims = videoDimensions(au.data, session.codec)
          if (dims) {
            session.lastStats.width = dims.width
            session.lastStats.height = dims.height
            log(`resolution ${dims.width}x${dims.height} (from SPS)`)
          }
        }
        trackJitter(session)
        feedRender(session, au.data)
      }
    })
    track.onError((err) => {
      if (current === session) log(`track error: ${err}`)
    })
  })
}

// Frames now flow only on desktop change (ddagrab dup_frames=0), so a static
// screen yields long, irregular gaps that are NOT network jitter. Exclude any gap
// above this and re-seed, so jitterMs reflects only active-streaming pacing.
const JITTER_IDLE_GAP_MS = 100

// Smoothed frame-pacing jitter (RFC3550 §A.8 style, /16), on AU arrival wall clock.
function trackJitter(session: Session): void {
  const now = performance.now()
  if (session.lastAuArrivalMs !== 0) {
    const interval = now - session.lastAuArrivalMs
    if (interval > JITTER_IDLE_GAP_MS) {
      session.meanIntervalMs = 0 // idle gap (static screen) -- re-seed, not jitter
    } else {
      if (session.meanIntervalMs === 0) session.meanIntervalMs = interval
      const deviation = Math.abs(interval - session.meanIntervalMs)
      session.jitterMs += (deviation - session.jitterMs) / 16
      session.meanIntervalMs += (interval - session.meanIntervalMs) / 16
    }
  }
  session.lastAuArrivalMs = now
}

function reportStats(session: Session): void {
  if (current !== session) return
  const windowSec = STATS_INTERVAL_MS / 1000
  // NOTE: pc.rtt() reads the SCTP transport, but this connection is media-only
  // (no data channel) so it's always null here. The controller derives network
  // RTT from the input pc's candidate-pair instead (ControllerSession onStats).
  const stats: NativeVideoStats = {
    fps: Math.round(session.framesInWindow / windowSec),
    width: session.lastStats.width ?? 0,
    height: session.lastStats.height ?? 0,
    kbps: Math.round((session.bytesInWindow * 8) / 1000 / windowSec),
    captureMs: null,
    encodeMs: null,
    decodeMs: session.lastStats.decodeMs ?? null,
    renderMs: session.lastStats.renderMs ?? null,
    rttMs: null, // derived on the controller from the input pc (see above)
    jitterMs: session.framesInWindow > 0 ? Math.round(session.jitterMs) : null,
    codec: session.codec
  }
  // Per-second stats to the log too (not just the HUD) so frame-pacing evidence —
  // fps swing + jitter over time, vs Parsec — is inspectable after the fact (golden
  // rule #1). With change-detection capture fps is INTENTIONALLY variable (idle→low,
  // motion→high, like Parsec); jitterMs is the real smoothness metric.
  log(
    `stats fps=${stats.fps} jitter=${stats.jitterMs ?? '-'}ms kbps=${stats.kbps} ${stats.width}x${stats.height}`
  )
  session.framesInWindow = 0
  session.bytesInWindow = 0
  send({ evt: 'stats', stats })

  // BWE: close the loss window, run AIMD, and push a new bitrate target to the
  // sender ONLY when it moved enough to matter (hysteresis in the estimator). A
  // static screen produces no packets -> tick() is null -> hold. main relays this
  // over signaling ('video-bitrate') -> agent -> capturer stdin 'B<kbps>'.
  const bwe = session.bwe.tick(stats.jitterMs)
  if (bwe?.changed) {
    log(`bwe loss=${(bwe.lossFraction * 100).toFixed(1)}% -> target ${bwe.targetKbps}kbps`)
    send({ evt: 'bitrate', kbps: bwe.targetKbps })
  }
}

// ── IPC in (MainToVideoReceiver) ──────────────────────────────────────────────
process.on('message', (raw: MainToVideoReceiver) => {
  switch (raw.cmd) {
    case 'start-session':
      startSession()
      break
    case 'remote-offer':
      if (!current) {
        log('remote-offer with no active session -- ignored')
        break
      }
      log(`remote-offer (${raw.sdp.length} bytes)`)
      // Auto-detect the codec from the offer's rtpmap (the agent advertises H265 only
      // when it opted into VIDEO_CODEC=hevc). Swap the depacketizer to the matching
      // RTP payload format and tell main so it sets the Swift decoder before any AU
      // arrives. No controller-side config needed -- the sender's choice drives it.
      {
        const offered: VideoCodec = /a=rtpmap:\d+\s+H265\//i.test(raw.sdp) ? 'hevc' : 'h264'
        if (offered !== current.codec) {
          current.codec = offered
          current.depacketizer = createDepacketizer(offered)
          log(`codec detected from offer: ${offered}`)
          send({ evt: 'codec', codec: offered })
        }
      }
      try {
        current.pc.setRemoteDescription(raw.sdp, 'offer')
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

send({ evt: 'ready' })
log('video receiver helper started')
