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
import { initLogger, type LogLevel } from 'node-datachannel'
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
import {
  runClipboardSync,
  type ClipboardChannelLike
} from '../renderer/src/shared/clipboard/clipboardSyncCore'
import { readClipboardText, writeClipboardText } from './clipboardNative'
import { logInputHelper } from '../main/inputHelperLog'

// TEMP diagnostic (helper-session-flapping investigation, see
// docs/native-input-plan.md). `session` is passed explicitly rather than
// read from the current sessionCounter -- a pc's own callbacks (onicecandidate,
// onconnectionstatechange, channel.onmessage) close over the session number
// they were CREATED under, so if one fires after a NEWER session has already
// started, the log line still shows the OLD session number: the smoking gun
// for "a stale pc's event leaked into a later session".
function log(session: number, message: string): void {
  logInputHelper('HELPER', `[session ${session}] ${message}`)
}

// TEMP diagnostic: node-datachannel's own (libdatachannel/libjuice) debug
// log, redirected here instead of stdout (a packaged build's helper has no
// console at all). Level defaults to 'Debug' -- can be turned down via
// NDC_LOG_LEVEL if it proves too noisy to read by hand. Logged with
// `sessionCounter` (not a per-pc session, since these lines originate from
// the native library itself, not from one of our own pc-bound handlers).
initLogger((process.env.NDC_LOG_LEVEL as LogLevel | undefined) ?? 'Debug', (level, message) => {
  logInputHelper('HELPER', `[session ${sessionCounter}] [ndc:${level}] ${message}`)
})

// Mirrors shared/webrtc/peerConnection.ts's ICE_SERVERS -- duplicated rather
// than imported because that file lives under renderer/src and assumes a
// browser's global RTCPeerConnection; this process supplies its own via the
// node-datachannel polyfill instead. Keep these two lists in sync by hand.
//
// openrelay.metered.ca's STUN and TURN were both removed here (and in
// peerConnection.ts) after a real 8-round packaged test's log proved them
// non-functional: libjuice's own debug log showed which STUN server each
// negotiation attempt picked (it isn't deterministic across attempts, even
// with the same iceServers array) -- every attempt that picked
// stun.l.google.com connected, every attempt that picked
// openrelay.metered.ca sat in `connecting` until it timed out, 14/14 times,
// no exceptions. TURN allocation against openrelay also failed every time it
// was logged, and no `typ relay` candidate appears anywhere across the whole
// (9500+ line) log -- the TURN relay fallback was never actually working
// either. See docs/native-input-plan.md's stun-server-flapping addendum.
//
// A single STUN server is itself a single point of failure (exactly what
// just went wrong with openrelay), so stun.cloudflare.com is added as a
// second, independent option -- but only after sending it a real RFC 5389
// Binding Request from this machine and confirming a valid Binding Success
// Response came back (6/6 across 3 separate runs), the same verification
// openrelay never got before it was originally added.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]

// TEMP diagnostic: pulls the `typ host|srflx|relay` suffix out of a raw ICE
// candidate string so the log says outright whether a server-reflexive/relay
// candidate ever gets gathered, instead of requiring a human to decode a
// candidate string by eye.
function candidateType(candidate: string): string {
  return /typ (\w+)/.exec(candidate)?.[1] ?? '?'
}

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
// TEMP diagnostic (helper-session-flapping investigation): incremented on
// every negotiation attempt (including retries -- see attemptNegotiation()),
// so a pc's callbacks always log the attempt number they were created under,
// even if `sessionCounter` has since moved on to a newer attempt/session.
let sessionCounter = 0

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
      // TEMP diagnostic (keyboard-injection-silent-failure investigation,
      // see docs/native-input-plan.md): logs every real keyboard message
      // this process receives and injects, so a real session from the Mac
      // controller can be checked against %TEMP%\input-helper.log to
      // confirm messages actually arrive here and injection doesn't throw
      // -- remove once the Win32 SendInput keyboard path is confirmed
      // solid across real hardware rounds, not just this sandboxed dev
      // environment's own oracle.
      log(currentSession?.session ?? sessionCounter, `${message.t} code=${message.code}`)
      await keyToggle(message.code, message.t === 'keydown')
      break
    case 'text':
      log(
        currentSession?.session ?? sessionCounter,
        `text len=${message.text.length} codePoints=${JSON.stringify(Array.from(message.text).map((c) => c.codePointAt(0)))}`
      )
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
      await handleRemoteInput(next).catch((err) => {
        // Was a bare .catch(() => {}) that silently swallowed every
        // injection error -- see docs/native-input-plan.md's keyboard-
        // injection-silent-failure addendum. Logging here is what would
        // reveal whether keydown/keyup/text ever actually throws in real
        // usage (isolated testing found no exception for any nut.js
        // keyboard call under ELECTRON_RUN_AS_NODE -- ASCII, Thai text, and
        // modifier combos all resolved cleanly -- so this may still log
        // nothing even while real keyboard input silently fails to reach
        // the OS, which would point at a delivery-level issue instead).
        log(
          currentSession?.session ?? sessionCounter,
          `handleRemoteInput REJECTED for ${next.t}: ${err?.stack ?? err}`
        )
      })
    }
    inputDraining = false
  })()
}

// TEMP diagnostic (helper-session-flapping investigation): tracks the
// currently-active attempt's number and per-attempt counters, so the
// module-level process.on('message') handler below (which isn't inside
// attemptNegotiation()'s closure) can still log with the right number and
// running counts for remote-answer/remote-ice.
let currentSession: { session: number; incomingIce: number; inputMessages: number } | undefined

// Self-healing retry (see docs/native-input-plan.md's helper-session-
// flapping addendum): if a negotiation attempt doesn't reach 'connected'
// within CONNECT_TIMEOUT_MS, close it and start over with a brand new
// RTCPeerConnection + fresh offer, up to MAX_ATTEMPTS total for one
// top-level start-session before giving up. Retries are NOT silent renegs of
// the same pc (which failed to reach connected for whatever reason, possibly
// leftover native state) -- they're a full teardown and a genuinely new
// negotiation, same as the fix for the stale-event leak: don't try to repair
// a connection whose state might already be confused, replace it outright.
const CONNECT_TIMEOUT_MS = process.env.NDC_TEST_SHORT_TIMEOUT === '1' ? 100 : 5_000
const MAX_ATTEMPTS = 3
let attemptNumber = 0
let connectTimeout: ReturnType<typeof setTimeout> | undefined
// Stops the clipboard-sync poll for the current session's clipboard channel;
// re-created per negotiation attempt, so the previous one must be torn down
// before the next starts (otherwise stale poll intervals stack up).
let clipboardStop: (() => void) | null = null

function clearConnectTimeout(): void {
  if (connectTimeout) clearTimeout(connectTimeout)
  connectTimeout = undefined
}

function closeSession(): void {
  log(sessionCounter, `closeSession() called, pc=${pc ? 'present' : 'none'}`)
  clearConnectTimeout()
  if (clipboardStop) {
    clipboardStop()
    clipboardStop = null
  }
  if (pc) {
    // Belt-and-suspenders: null the pc-level handlers before close(), on top
    // of the `pc !== conn` guard inside each handler below. Confirmed by an
    // isolated repro (see docs/native-input-plan.md, "helper-session-
    // flapping") that node-datachannel's close() does NOT synchronously stop
    // all native event delivery -- a closed pc's own onconnectionstatechange
    // fired again well after close() was called and after a NEWER session's
    // pc already existed. Without a guard, that stale event's side effects
    // (relaying an ICE candidate that belongs to a different, dead
    // negotiation) get attributed to whatever session is current when they
    // finally arrive, corrupting it with mismatched ICE credentials -- one
    // possible contributor to the observed flapping (works, dies, works,
    // dies...); see the addendum for what the evidence actually showed.
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    pc.onicegatheringstatechange = null
    pc.close()
  }
  pc = undefined
  currentSession = undefined
  resetInputQueue()
}

function startSession(): void {
  attemptNumber = 0
  attemptNegotiation()
}

// The agent is always the offerer for the input PC too, for parity with the
// existing video PC (see AgentView.tsx) and because renegotiation isn't
// needed this way -- both data channels are known upfront. Called once for
// the initial attempt and again (with a fresh pc) for each retry.
function attemptNegotiation(): void {
  closeSession()
  attemptNumber += 1
  sessionCounter += 1
  const mySession = sessionCounter
  currentSession = { session: mySession, incomingIce: 0, inputMessages: 0 }
  log(
    mySession,
    `start-session, attempt ${attemptNumber}/${MAX_ATTEMPTS}, creating new RTCPeerConnection` +
      ` (iceServers=${ICE_SERVERS.length})`
  )
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  pc = conn
  let outgoingIce = 0

  // Every handler below checks `pc !== conn` first and bails if so -- this
  // pc has been superseded by a later attempt (closeSession() nulls the
  // pc-level handlers above as a first line of defense, but the data-channel
  // handlers are local to this closure and can't be nulled from there, so
  // this guard is the one mechanism that reliably covers all of them). Bound
  // to `conn`/`mySession` via closure, NOT the module-level `pc`/
  // `sessionCounter`, so a stale event is recognized as stale rather than
  // silently attributed to whatever attempt happens to be current when it
  // arrives.
  conn.onconnectionstatechange = () => {
    if (pc !== conn) {
      log(mySession, `IGNORED stale pc connectionState=${conn.connectionState} (superseded)`)
      return
    }
    log(mySession, `pc connectionState=${conn.connectionState}`)
    if (conn.connectionState === 'connected') clearConnectTimeout()
  }

  conn.onicegatheringstatechange = () => {
    if (pc !== conn) return
    log(mySession, `iceGatheringState=${conn.iceGatheringState}`)
  }

  conn.onicecandidate = (event) => {
    if (pc !== conn) {
      log(mySession, 'IGNORED stale outgoing ICE candidate (superseded)')
      return
    }
    if (event.candidate) {
      outgoingIce += 1
      log(
        mySession,
        `outgoing ICE candidate #${outgoingIce} type=${candidateType(event.candidate.candidate)}`
      )
      send({
        evt: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      })
    }
  }

  const onChannelMessage = (event: MessageEvent): void => {
    if (pc !== conn) {
      log(mySession, 'IGNORED stale data channel message (superseded)')
      return
    }
    if (currentSession?.session === mySession) currentSession.inputMessages += 1
    // Kept as a permanent diagnostic (this log solved the session-flapping
    // bug; packaged builds have no console) but sampled sparsely -- at
    // 60 moves/sec, every-25th wrote ~2.4 lines/sec of active use, growing
    // the file by MBs per hour. One line per 500 messages (~8s of movement)
    // still proves input is flowing without turning the log into a firehose.
    if ((currentSession?.inputMessages ?? 0) % 500 === 1) {
      log(mySession, `input message #${currentSession?.inputMessages}`)
    }
    enqueueRemoteInput(JSON.parse(event.data as string) as RemoteInputMessage)
  }
  const input = conn.createDataChannel('input')
  input.onopen = () => {
    if (pc !== conn) return
    log(mySession, 'data channel "input" open')
  }
  input.onmessage = onChannelMessage
  const moves = conn.createDataChannel('input-moves', {
    ordered: false,
    maxRetransmits: 0
  })
  moves.onopen = () => {
    if (pc !== conn) return
    log(mySession, 'data channel "input-moves" open')
  }
  moves.onmessage = onChannelMessage

  // Clipboard sync lives here in the helper (not the agent renderer) for the
  // same reason input does: when the agent window is hidden, the renderer is
  // throttled, but this process keeps polling. The controller side stays in
  // its renderer (its window is focused while controlling). The shared core
  // (clipboardSyncCore) handles the echo-guard/poll; this process just gives
  // it OS-level clipboard access (clipboardNative).
  const clipboard = conn.createDataChannel('clipboard')
  clipboard.onopen = () => {
    if (pc !== conn) return
    log(mySession, 'data channel "clipboard" open')
  }
  clipboardStop = runClipboardSync(clipboard as unknown as ClipboardChannelLike, {
    read: readClipboardText,
    write: writeClipboardText
  })

  void (async () => {
    const offer = await conn.createOffer()
    await conn.setLocalDescription(offer)
    if (pc !== conn) {
      log(
        mySession,
        'IGNORED stale offer (superseded before createOffer/setLocalDescription resolved)'
      )
      return
    }
    log(mySession, `offer created, sdp length=${offer.sdp?.length}`)
    send({ evt: 'offer', sdp: offer.sdp! })
  })().catch((err) => log(mySession, `createOffer/setLocalDescription REJECTED: ${err}`))

  clearConnectTimeout()
  connectTimeout = setTimeout(() => {
    if (pc !== conn) return // superseded by something else already, nothing to do
    log(
      mySession,
      `CONNECT TIMEOUT after ${CONNECT_TIMEOUT_MS}ms -- state=${conn.connectionState}` +
        ` gatheringState=${conn.iceGatheringState} outgoingIce=${outgoingIce}` +
        ` incomingIce=${currentSession?.incomingIce ?? 0} attempt=${attemptNumber}/${MAX_ATTEMPTS}`
    )
    if (attemptNumber < MAX_ATTEMPTS) {
      log(mySession, 'retrying: closing and creating a fresh RTCPeerConnection')
      attemptNegotiation()
    } else {
      log(mySession, `giving up after ${MAX_ATTEMPTS} attempts -- exiting for a clean respawn`)
      send({ evt: 'fatal', message: `input PC negotiation failed after ${MAX_ATTEMPTS} attempts` })
      closeSession()
      // Safety net (see docs/native-input-plan.md): a helper that's failed
      // to connect 3 times in a row might have some kind of degraded native
      // state that a same-process retry can't fix (this is exactly the
      // uncertainty the v1.14.2 "all 3 attempts stall identically" report
      // raised, before the STUN root cause was found) -- rather than sit
      // alive indefinitely after sending 'fatal', exit outright so
      // inputHelperHost's existing exit-handler respawns a genuinely fresh
      // process (new native module state, new everything) for the next
      // pairing attempt. setImmediate gives the 'fatal' IPC message a tick
      // to actually flush before the process goes away.
      setImmediate(() => process.exit(1))
    }
  }, CONNECT_TIMEOUT_MS)
}

process.on('message', (raw: MainToHelper) => {
  switch (raw.cmd) {
    case 'start-session':
      startSession()
      break
    case 'stop-session':
      log(sessionCounter, 'stop-session received')
      closeSession()
      break
    case 'remote-answer': {
      const session = currentSession?.session ?? sessionCounter
      if (!currentSession || !pc) {
        log(
          session,
          'remote-answer received but no active pc (already closed/superseded) -- ignored'
        )
        break
      }
      log(session, `remote-answer received, sdp length=${raw.sdp.length}`)
      void pc
        .setRemoteDescription({ type: 'answer', sdp: raw.sdp })
        .catch((err) => log(session, `setRemoteDescription REJECTED: ${err}`))
      break
    }
    case 'remote-ice': {
      const session = currentSession?.session ?? sessionCounter
      if (!currentSession || !pc) {
        log(session, 'remote-ice received but no active pc (already closed/superseded) -- ignored')
        break
      }
      currentSession.incomingIce += 1
      log(session, `remote-ice received #${currentSession.incomingIce}`)
      void pc
        .addIceCandidate({
          candidate: raw.candidate,
          sdpMid: raw.sdpMid ?? undefined,
          sdpMLineIndex: raw.sdpMLineIndex ?? undefined
        })
        .catch((err) => log(session, `addIceCandidate REJECTED: ${err}`))
      break
    }
    case 'ping':
      send({ evt: 'pong' })
      break
  }
})

process.on('uncaughtException', (err) => {
  log(currentSession?.session ?? sessionCounter, `uncaughtException: ${err?.stack ?? err}`)
  send({ evt: 'fatal', message: err?.stack ?? String(err) })
  process.exit(1)
})

// TEMP diagnostic (helper-session-flapping investigation): setRemoteDescription/
// addIceCandidate/createOffer above are all fire-and-forget promises with no
// .catch() in the ORIGINAL code -- an unhandled rejection from any of them
// would silently kill this process (Node's default since v15), which would
// explain the observed crash-respawn flapping with no other visible cause.
// This handler's own .catch() calls above should already surface any such
// rejection in the log; this is a backstop in case something rejects from
// somewhere else not yet wrapped.
process.on('unhandledRejection', (reason) => {
  log(currentSession?.session ?? sessionCounter, `unhandledRejection: ${reason}`)
})

send({ evt: 'ready' })
