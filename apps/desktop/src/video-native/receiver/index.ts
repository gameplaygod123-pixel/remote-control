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
import { BandwidthEstimator, bweCeilingForCodec, LossDetector } from './bwe'
import { SeqReorderBuffer } from './reorderBuffer'

// Phase C of the NACK endgame (docs/step-nack-retransmit.md): with the patched ndc
// (native/ndc-nack) emitting NACKs, hold RTP packets in a shallow seq-ordered buffer so
// a ~1-RTT retransmit fills a gap before the frame is presented -> silent loss repair
// (no PLI/IDR/fps-dip). DEFAULT ON (B1: the owner's verified stack; the patched
// darwin-arm64 ndc ships committed + is auto-reapplied by postinstall). VIDEO_NACK_BUFFER=0
// forces today's immediate-PLI path. Without the patched ndc no NACKs arrive, so the buffer
// just releases each small gap on its short timeout -> at worst a hair more delay, never a break.
function nackBufferEnabled(): boolean {
  return process.env.VIDEO_NACK_BUFFER !== '0'
}
import { logVideoReceiver } from '../../main/videoReceiverLog'

// Must match the sender (sender/index.ts): same STUN pair (golden rule #4), same
// verified servers -- a single STUN server is a single point of failure. TURN is
// appended ONLY when configured via env (default STUN-only = byte-identical), for
// symmetric-NAT/CGNAT peers STUN can't reach; opt-in + must be a verified server.
// Env (inherited from the controller process): PR_TURN_URLS (comma list) +
// PR_TURN_USERNAME + PR_TURN_CREDENTIAL. ndc string form: turn:USER:CRED@host:port.
function buildIceServers(): string[] {
  const servers = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
  const urls = (process.env.PR_TURN_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const user = process.env.PR_TURN_USERNAME ?? ''
  const cred = process.env.PR_TURN_CREDENTIAL ?? ''
  for (const url of urls) {
    const m = /^(turns?):(.+)$/.exec(url)
    servers.push(m && user && cred ? `${m[1]}:${user}:${cred}@${m[2]}` : url)
  }
  return servers
}
const ICE_SERVERS = buildIceServers()
const STATS_INTERVAL_MS = 1_000
// Rate-limit our PLI to the agreed <=1/s (two-sided design: sender debounces
// forced IDRs at 400ms, receiver never storms it) -- see sender/index.ts item A.
const KEYFRAME_REQUEST_COOLDOWN_MS = 1_000
// How long the Phase C reorder buffer holds a small gap waiting for the NACK retransmit
// (~1 RTT ≈ 11ms on this link + margin). Latency is only added when a gap actually occurs.
const NACK_BUFFER_HOLD_MS = 30

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
  // Real-time packet-loss detector (reorder-tolerant). A confirmed lost packet breaks
  // the current frame, and since inter frames reference it the decoder (VideoToolbox)
  // stalls until the next decodable entry -- without a PLI that's the periodic IDR
  // (~2s @ gop 120), the ~2s freeze WC saw on HEVC. On confirmed loss we PLI so the
  // sender forces a cheap IDR (~1 RTT recovery). Reorder tolerance avoids PLIing for a
  // packet that merely arrived out of order (a self-inflicted judder).
  lossDetector: LossDetector
  // Phase C: shallow seq-ordered RTP buffer (null unless VIDEO_NACK_BUFFER=1). When set,
  // packets flow through it (retransmit-aware, in-order release) instead of straight to
  // the depacketizer; lossDetector then only MEASURES network loss (stats), and the
  // buffer's onGap drives the PLI for losses the retransmit couldn't repair.
  reorder: SeqReorderBuffer | null
  // Auto-test instrumentation (parsed by scripts/analyze-session.mjs): a "hitch" is
  // the interval from a detected loss to the next keyframe AU that recovers decode.
  // hitchStartMs = perf.now of the loss that opened the current unrecovered hitch (0
  // = not in a hitch). Per-window loss/pli counters feed the structured stats line.
  hitchStartMs: number
  lossEventsInWindow: number
  lostPacketsInWindow: number
  pliInWindow: number
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
  s.pliInWindow += 1
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
    lossDetector: new LossDetector(),
    reorder: null,
    hitchStartMs: 0,
    lossEventsInWindow: 0,
    lostPacketsInWindow: 0,
    pliInWindow: 0,
    framesInWindow: 0,
    bytesInWindow: 0,
    lastAuArrivalMs: 0,
    meanIntervalMs: 0,
    jitterMs: 0,
    statsTimer: undefined,
    lastStats: {}
  }
  current = session

  if (nackBufferEnabled()) {
    session.reorder = new SeqReorderBuffer(
      {
        onPacket: (pkt) => processPacket(session, pkt),
        onGap: (count) => onConfirmedLoss(session, count)
      },
      { holdMs: NACK_BUFFER_HOLD_MS }
    )
    log(`NACK receive buffer ON (hold ${NACK_BUFFER_HOLD_MS}ms)`)
  }

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
      if (msg.length < 4) return
      const seq = msg.readUInt16BE(2)
      // BWE always sees the raw per-packet seq (network loss drives bitrate).
      session.bwe.observe(seq)

      if (session.reorder) {
        // Phase C path: lossDetector MEASURES network loss for the stats line only (so
        // the analyzer still shows loss=/lostpkts= = what the link dropped), while the
        // reorder buffer decides recovery -- a gap the retransmit fills is released
        // silently (no PLI, no hitch); one it can't (blackout / retransmit lost) surfaces
        // via onGap -> onConfirmedLoss -> PLI. So pli=/hitch reflect UNRECOVERED loss.
        const lost = session.lossDetector.observe(seq)
        if (lost > 0) {
          session.lossEventsInWindow += 1
          session.lostPacketsInWindow += lost
        }
        session.reorder.push(seq, msg)
        return
      }

      // Default path (no NACK buffer): reorder-tolerant loss detection -> immediate PLI so
      // the sender forces a cheap IDR (capturer 'I' stdin) and the decoder recovers in ~1
      // RTT instead of waiting for the periodic IDR (~2s).
      const lost = session.lossDetector.observe(seq)
      if (lost > 0) {
        session.lossEventsInWindow += 1
        session.lostPacketsInWindow += lost
        if (session.hitchStartMs === 0) session.hitchStartMs = performance.now()
        requestKeyframe(session, `packet loss (${lost} pkt)`)
      }
      processPacket(session, msg)
    })
    track.onError((err) => {
      if (current === session) log(`track error: ${err}`)
    })
  })
}

// A confirmed UNRECOVERED loss from the reorder buffer (retransmit never arrived, or a
// blackout too big to NACK): open a hitch + PLI so the sender forces a recovering IDR.
// Distinct from the network-loss counters (which the lossDetector already bumped) -- this
// is the loss that actually costs a visible recovery.
function onConfirmedLoss(s: Session, count: number): void {
  if (s.hitchStartMs === 0) s.hitchStartMs = performance.now()
  requestKeyframe(s, `packet loss (${count} pkt, unrecovered)`)
}

// Depacketize one in-order RTP packet and emit any completed access units (hitch-close,
// one-time resolution read, jitter, render). Shared by the default path and the reorder
// buffer's ordered-release callback.
function processPacket(s: Session, msg: Buffer): void {
  for (const au of s.depacketizer.push(msg)) {
    s.framesInWindow += 1
    s.bytesInWindow += au.data.length
    // Close an open hitch when a keyframe (the recovering IDR) arrives: the real
    // perceived-freeze duration (loss -> decodable again), logged for the auto-analyzer.
    if (au.keyframe && s.hitchStartMs > 0) {
      const ms = Math.round(performance.now() - s.hitchStartMs)
      s.hitchStartMs = 0
      log(`hitch recovered in ${ms}ms (loss -> keyframe)`)
    }
    // Read the real resolution off the in-band SPS once (first AU = IDR + parameter sets).
    if (!s.lastStats.width) {
      const dims = videoDimensions(au.data, s.codec)
      if (dims) {
        s.lastStats.width = dims.width
        s.lastStats.height = dims.height
        log(`resolution ${dims.width}x${dims.height} (from SPS)`)
      }
    }
    trackJitter(s)
    feedRender(s, au.data)
  }
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
  // motion→high, like Parsec); jitterMs is the real smoothness metric. loss/pli are
  // this window's counts (parsed by scripts/analyze-session.mjs for the auto-report).
  log(
    `stats fps=${stats.fps} jitter=${stats.jitterMs ?? '-'}ms kbps=${stats.kbps} ` +
      `loss=${session.lossEventsInWindow} lostpkts=${session.lostPacketsInWindow} ` +
      `pli=${session.pliInWindow} ${stats.width}x${stats.height}`
  )
  session.framesInWindow = 0
  session.bytesInWindow = 0
  session.lossEventsInWindow = 0
  session.lostPacketsInWindow = 0
  session.pliInWindow = 0
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
          current.reorder?.reset() // new offer = fresh seq stream; drop any held packets
          // HEVC gets a LOWER BWE ceiling (15 vs 25 Mbps): HEVC@15 ≈ H.264@25 quality,
          // and capping it at 25 overflowed the Parsec-shared link -> loss -> ~2s
          // decode stalls (v1.28.0-beta.1). Re-seed the estimator before any packets.
          current.bwe = new BandwidthEstimator(bweCeilingForCodec(offered))
          log(`codec detected from offer: ${offered} (bwe cap ${bweCeilingForCodec(offered)}kbps)`)
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
