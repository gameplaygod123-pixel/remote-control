// Pure-Node entry point for the Mac controller's native VIDEO RECEIVER helper.
//
// Spawned with ELECTRON_RUN_AS_NODE=1 by main/videoReceiverHost.ts (same trick as
// the input helper / video sender). It answers the agent's native offer on
// channel:'video-native', receives the H.264 RTP track via node-datachannel,
// reassembles Annex-B access units (ndc has no H.264 depacketizer -- see
// rtpDepacketizer.ts), and streams them to the Swift render binary for
// VideoToolbox decode + AVSampleBufferVideoRenderer present. The agent is the SDP
// offerer (unchanged); we ANSWER. Talks to Electron main ONLY over the frozen IPC
// contract in ../shared/ipc.ts.
//
// This is the inverse of sender/index.ts and shares its shape (raw ndc media API,
// wall-clock-free since we only consume, RtcpReceivingSession for RTCP + the
// track.requestKeyframe() PLI the sender's item-A recovery listens for).

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import {
  PeerConnection,
  RtcpReceivingSession,
  initLogger,
  type Track,
  type LogLevel
} from 'node-datachannel'
import type { MainToVideoReceiver, VideoReceiverToMain } from '../shared/ipc'
import type { NativeVideoStats } from '../shared/contract'
import { H264Depacketizer, isRtcp } from './rtpDepacketizer'
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

// The Swift render binary: explicit path (dev/test) else bundled under Resources.
// Not committed to the repo build yet (Phase 2 packaging); until then set
// VIDEO_RENDER_PATH. --selftest verified it standalone (render/README.md).
function resolveRenderPath(): string | null {
  const fromEnv = process.env.VIDEO_RENDER_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const resDir = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resDir) {
    const bundled = join(resDir, 'video-render', 'video-render')
    if (existsSync(bundled)) return bundled
  }
  return null
}

interface Session {
  id: number
  pc: InstanceType<typeof PeerConnection>
  track: Track | null
  depacketizer: H264Depacketizer
  render: ChildProcess | null
  renderStdin: Writable | null
  renderControl: Writable | null
  firstFrameSeen: boolean
  lastKeyframeRequestAt: number
  framesInWindow: number
  bytesInWindow: number
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
    s.render?.kill()
  } catch (e) {
    log(`render.kill threw: ${(e as Error).message}`)
  }
  try {
    s.pc.close()
  } catch (e) {
    log(`pc.close threw: ${(e as Error).message}`)
  }
}

// Length-prefix an access unit and hand it to the Swift binary's stdin. The
// binary reads [4-byte BE length][AU bytes] (render/README.md).
function feedRender(s: Session, au: Buffer): void {
  if (!s.renderStdin) return
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(au.length, 0)
  try {
    s.renderStdin.write(head)
    s.renderStdin.write(au)
  } catch (e) {
    log(`render stdin write threw: ${(e as Error).message}`)
  }
}

function requestKeyframe(s: Session, reason: string): void {
  if (!s.track) return
  const now = performance.now()
  if (s.lastKeyframeRequestAt !== 0 && now - s.lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) {
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

function spawnRender(s: Session): void {
  const renderPath = resolveRenderPath()
  if (!renderPath) {
    send({ evt: 'fatal', message: 'render binary not found (set VIDEO_RENDER_PATH)' })
    return
  }
  log(`spawning render binary: ${renderPath}`)
  // stdio: 0=stdin(AUs), 1=stdout(events), 2=stderr(logs), 3=control(render-rect/stop)
  const proc = spawn(renderPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  s.render = proc
  s.renderStdin = proc.stdin
  s.renderControl = proc.stdio[3] as Writable

  let outAcc = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (current !== s) return
    outAcc += chunk.toString()
    let nl: number
    while ((nl = outAcc.indexOf('\n')) >= 0) {
      const line = outAcc.slice(0, nl)
      outAcc = outAcc.slice(nl + 1)
      handleRenderEvent(s, line)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) log(`render: ${line}`)
  })
  proc.on('exit', (code, signal) => {
    log(`render binary exit code=${code} signal=${signal}`)
    if (current === s) {
      s.render = null
      s.renderStdin = null
      s.renderControl = null
    }
  })
}

function handleRenderEvent(s: Session, line: string): void {
  let obj: { evt?: string; [k: string]: unknown }
  try {
    obj = JSON.parse(line)
  } catch {
    return
  }
  switch (obj.evt) {
    case 'ready':
      log('render binary ready')
      break
    case 'first-frame':
      if (!s.firstFrameSeen) {
        s.firstFrameSeen = true
        log('first-frame on screen')
        send({ evt: 'first-frame' })
      }
      break
    case 'stats':
      // Decode/render ms come from the binary; fps/kbps we compute from RTP.
      if (typeof obj.decodeMs === 'number') s.lastStats.decodeMs = obj.decodeMs
      if (typeof obj.renderMs === 'number') s.lastStats.renderMs = obj.renderMs
      break
    case 'need-keyframe':
      requestKeyframe(s, 'render decode error')
      break
  }
}

function sendControl(s: Session, obj: Record<string, unknown>): void {
  if (!s.renderControl) return
  try {
    s.renderControl.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    log(`render control write threw: ${(e as Error).message}`)
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
    depacketizer: new H264Depacketizer(),
    render: null,
    renderStdin: null,
    renderControl: null,
    firstFrameSeen: false,
    lastKeyframeRequestAt: 0,
    framesInWindow: 0,
    bytesInWindow: 0,
    statsTimer: undefined,
    lastStats: {}
  }
  current = session

  spawnRender(session)

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
      for (const au of session.depacketizer.push(msg)) {
        session.framesInWindow += 1
        session.bytesInWindow += au.data.length
        feedRender(session, au.data)
      }
    })
    track.onError((err) => {
      if (current === session) log(`track error: ${err}`)
    })
  })
}

function reportStats(session: Session): void {
  if (current !== session) return
  const windowSec = STATS_INTERVAL_MS / 1000
  const stats: NativeVideoStats = {
    fps: Math.round(session.framesInWindow / windowSec),
    width: session.lastStats.width ?? 0,
    height: session.lastStats.height ?? 0,
    kbps: Math.round((session.bytesInWindow * 8) / 1000 / windowSec),
    captureMs: null,
    encodeMs: null,
    decodeMs: session.lastStats.decodeMs ?? null,
    renderMs: session.lastStats.renderMs ?? null,
    rttMs: null,
    codec: 'h264'
  }
  session.framesInWindow = 0
  session.bytesInWindow = 0
  send({ evt: 'stats', stats })
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
    case 'set-render-rect':
      if (current) {
        sendControl(current, {
          cmd: 'render-rect',
          x: raw.x,
          y: raw.y,
          width: raw.width,
          height: raw.height,
          scale: raw.scale
        })
      }
      break
    case 'stop-session':
      log('stop-session')
      if (current) sendControl(current, { cmd: 'stop' })
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
