// Pure-Node entry point for the agent's input-helper process. Deliberately
// NOT run inside Electron's normal main-process runtime: it's spawned with
// ELECTRON_RUN_AS_NODE=1 (see main/inputHelperHost.ts), which runs Electron's
// bundled Node with no Chromium/renderer attached at all.
//
// Why this process exists: when the agent's window is hidden (closed to
// tray), Chromium throttles the ENTIRE Electron process's event loop, not
// just the renderer -- confirmed by instrumenting main-process timers and
// raw socket I/O, both of which stalled for the whole hidden period on the
// affected machine. A separate process with no Chromium message pump (this
// one) was measured to keep both timers and socket I/O running at full rate
// through the same freeze. So the WebRTC data channel that carries mouse/
// keyboard input lives here instead of in the renderer or Electron's main
// process, and is immune to the window-visibility-driven throttling that
// makes remote control input die the moment the agent window is closed.
// See docs/native-input-plan.md for the full investigation and design.
import { RTCPeerConnection } from 'node-datachannel/polyfill'
import {
  moveMouse,
  clickMouse,
  mouseButtonToggle,
  scrollMouse,
  keyToggle,
  typeText,
  getScreenSize
} from '../main/input/injector'
import type { RemoteInputMessage } from '../renderer/src/shared/input/inputProtocol'

// Mirrors shared/webrtc/peerConnection.ts's ICE_SERVERS -- duplicated rather
// than imported because that file lives under renderer/src and assumes a
// browser's global RTCPeerConnection; this process supplies its own via the
// node-datachannel polyfill instead. Keep these two lists in sync by hand.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

type MainToHelper =
  | { cmd: 'start-session' }
  | { cmd: 'stop-session' }
  | { cmd: 'remote-answer'; sdp: string }
  | { cmd: 'remote-ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { cmd: 'ping' }

type HelperToMain =
  | { evt: 'ready' }
  | { evt: 'offer'; sdp: string }
  | { evt: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { evt: 'pong' }
  | { evt: 'fatal'; message: string }

function send(message: HelperToMain): void {
  process.send?.(message)
}

let pc: InstanceType<typeof RTCPeerConnection> | undefined

// Cached after the first remote input message -- same rationale as the
// renderer's old cachedScreenSize: the agent's screen doesn't resize
// mid-session, and re-querying nut.js on every mousemove would add needless
// latency to the hottest path.
let cachedScreenSize: { width: number; height: number } | null = null

async function handleRemoteInput(message: RemoteInputMessage): Promise<void> {
  switch (message.t) {
    case 'move': {
      if (!cachedScreenSize) cachedScreenSize = await getScreenSize()
      await moveMouse(
        Math.round(message.x * cachedScreenSize.width),
        Math.round(message.y * cachedScreenSize.height)
      )
      break
    }
    case 'down':
    case 'up':
      await mouseButtonToggle(message.button, message.t === 'down')
      break
    case 'wheel':
      await scrollMouse(message.dy)
      break
    case 'keydown':
    case 'keyup':
      await keyToggle(message.code, message.t === 'keydown')
      break
    case 'text':
      await typeText(message.text)
      break
  }
}
// clickMouse is unused by the queue (button state always goes through
// mouseButtonToggle, matching the renderer's original handleRemoteInput) --
// imported anyway to keep the injector import list mirroring AgentView's, in
// case a future message type wants it.
void clickMouse

// Ported verbatim (in structure) from the renderer's enqueueRemoteInput/
// handleRemoteInput (see git history of AgentView.tsx): (a) keeps move->down
// ordering intact by draining everything through one loop, (b) collapses
// consecutive queued moves into just the newest one so a burst can never
// build a backlog of stale positions, (c) uses the moves' sequence numbers
// (from the unordered/no-retransmit channel) to drop any move that arrived
// late, rather than jerking the cursor backwards.
let inputQueue: RemoteInputMessage[] = []
let inputDraining = false
let lastMoveSeq = -1

function resetInputQueue(): void {
  inputQueue = []
  inputDraining = false
  lastMoveSeq = -1
}

function enqueueRemoteInput(message: RemoteInputMessage): void {
  if (message.t === 'move') {
    if (message.seq !== undefined) {
      if (message.seq <= lastMoveSeq) return // out-of-order stale move
      lastMoveSeq = message.seq
    }
    const last = inputQueue[inputQueue.length - 1]
    if (last?.t === 'move') {
      inputQueue[inputQueue.length - 1] = message // newest position supersedes
    } else {
      inputQueue.push(message)
    }
  } else {
    inputQueue.push(message)
  }
  if (inputDraining) return
  inputDraining = true
  void (async () => {
    while (inputQueue.length > 0) {
      const next = inputQueue.shift()!
      await handleRemoteInput(next).catch(() => {})
    }
    inputDraining = false
  })()
}

function closeSession(): void {
  pc?.close()
  pc = undefined
  resetInputQueue()
}

// The agent is always the offerer for the input PC too, for parity with the
// existing video PC (see AgentView.tsx) and because renegotiation isn't
// needed this way -- both data channels are known upfront.
function startSession(): void {
  closeSession()
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  pc = conn

  conn.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        evt: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      })
    }
  }

  const onChannelMessage = (event: MessageEvent): void => {
    enqueueRemoteInput(JSON.parse(event.data as string) as RemoteInputMessage)
  }
  const input = conn.createDataChannel('input')
  input.onmessage = onChannelMessage
  const moves = conn.createDataChannel('input-moves', {
    ordered: false,
    maxRetransmits: 0
  })
  moves.onmessage = onChannelMessage

  void (async () => {
    const offer = await conn.createOffer()
    await conn.setLocalDescription(offer)
    send({ evt: 'offer', sdp: offer.sdp! })
  })()
}

process.on('message', (raw: MainToHelper) => {
  switch (raw.cmd) {
    case 'start-session':
      startSession()
      break
    case 'stop-session':
      closeSession()
      break
    case 'remote-answer':
      void pc?.setRemoteDescription({ type: 'answer', sdp: raw.sdp })
      break
    case 'remote-ice':
      void pc?.addIceCandidate({
        candidate: raw.candidate,
        sdpMid: raw.sdpMid ?? undefined,
        sdpMLineIndex: raw.sdpMLineIndex ?? undefined
      })
      break
    case 'ping':
      send({ evt: 'pong' })
      break
  }
})

process.on('uncaughtException', (err) => {
  send({ evt: 'fatal', message: err?.stack ?? String(err) })
  process.exit(1)
})

send({ evt: 'ready' })
