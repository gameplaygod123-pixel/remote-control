import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { resolveSignalingUrl } from '../shared/signaling/resolveSignalingUrl'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import StatusPill, { classify } from '../shared/components/StatusPill'
import TransferStatus from '../shared/components/TransferStatus'
import { useFileTransferChannel } from '../shared/fileTransfer/useFileTransferChannel'
import { findDroppedDirectory } from '../shared/fileTransfer/fileTransferChannel'
import { getConnectionType, type ConnectionType } from '../shared/webrtc/connectionType'
import { useVideoStats, type VideoStats } from '../shared/webrtc/useVideoStats'
import { attachClipboardChannel } from '../shared/clipboard/clipboardSync'
import {
  RemoteInputMessage,
  type CursorShape,
  type RemoteCursorMessage,
  isPrintableKey,
  isEditableTarget,
  videoRelativePosition
} from '../shared/input/inputProtocol'
import { INPUT_HELPER_CAP } from '../shared/input/capabilities'
import { NATIVE_VIDEO_CAP, type NativeVideoStats } from '../../../video-native/shared/contract'

// Mousemove fires far more often than the remote side needs to react to --
// this caps how frequently position updates cross the data channel without
// making cursor movement feel laggy. Matched to the video's 60fps target
// (was 33ms/~30fps) so cursor updates aren't the bottleneck on
// responsiveness now that the video itself can keep up at that rate.
const MOUSE_MOVE_THROTTLE_MS = 16

// After a network drop -- or the agent machine being restarted by hand,
// which can take an arbitrarily long time -- the controller and agent
// reconnect independently with no ordering guarantee. Retry indefinitely on
// "unknown device id" specifically (not on a wrong PIN -- that's a real
// error, not a timing/availability issue) rather than giving up on what's
// virtually always just the agent not being back yet.
const PAIR_RETRY_DELAY_MS = 3000

export default function ControllerSession({
  deviceId,
  pin,
  name,
  onBack
}: {
  deviceId: string
  pin: string
  name?: string
  onBack: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState('connecting to signaling server')
  // Diagnostic for "why is a file transfer slow" -- 'relay' means traffic
  // is passing through the free TURN server (shared, bandwidth-limited)
  // rather than a direct path between the two machines.
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null)
  // Tracked as state (not just pcRef) so useVideoStats' effect re-runs
  // whenever the underlying peer connection is actually replaced --
  // mutating a ref doesn't trigger a re-render on its own.
  const [activePc, setActivePc] = useState<RTCPeerConnection | null>(null)
  const videoStats = useVideoStats(activePc, 'inbound')
  // Native pipeline stats come over IPC from the receiver helper (not from a
  // WebRTC pc), so they live in their own state; the HUD shows whichever path
  // is live. Null in the default WebRTC build -- displayStats then == videoStats.
  const [nativeStats, setNativeStats] = useState<VideoStats | null>(null)
  const displayStats = nativeStats ?? videoStats
  // True for this session once BOTH ends advertised native-video (set in
  // pair-result). Gates the native-only signaling branches below.
  const useNativeVideoRef = useRef(false)
  // Reactive mirror of useNativeVideoRef used only for styling: when true, the
  // session shell + video area go transparent so the native render window (which
  // sits BEHIND the transparent macOS window) shows through, while the opaque
  // floating controls stay on top and clickable.
  const [nativeActive, setNativeActive] = useState(false)
  // The remote machine's current cursor SHAPE (helper mode), applied as a CSS
  // `cursor` on the video element so macOS draws the matching native cursor
  // while the native video ships without a composited one (draw_mouse=0). Null
  // until the first shape arrives -> the local OS cursor shows meanwhile, so a
  // never-connecting cursor channel (or a non-Windows agent) degrades to the
  // plain local arrow instead of no cursor at all.
  const [remoteCursor, setRemoteCursor] = useState<CursorShape | null>(null)
  // OS fullscreen state. Native video composites inside this window now, so
  // fullscreen "just works" (one window); we only use this to hide the drag
  // titlebar in fullscreen, where the OS traffic-lights/exit are available.
  const [fullscreen, setFullscreen] = useState(false)
  // Sender-side (agent) encode time per frame, relayed over signaling from the
  // agent's video-sender ('video-sender-stats'); null until the capturer reports it
  // (H.264/NVENC encode ms). Shown in the HUD next to the receiver-side numbers so
  // the owner can see the encode cost at a glance (Parsec-overlay style).
  const [senderEncodeMs, setSenderEncodeMs] = useState<number | null>(null)
  // The live BWE bitrate target (kbps) the receiver's AIMD is asking the sender for,
  // so the HUD can show "actual → target" and the owner can watch auto-bitrate adapt.
  const [bweTargetKbps, setBweTargetKbps] = useState<number | null>(null)
  // Fetched from a main-process file rather than localStorage, which is
  // scoped to the Vite dev server's origin and would reset this identity
  // if the dev-server port ever shifted between runs.
  const [controllerId, setControllerId] = useState<string | null>(null)
  // Editable from this side too, not just the agent's own UI -- lets you
  // rename a device, or just jot a quick note ("downloading game") to
  // recognize it later in the Computers list. Sent as the same
  // set-device-name message the agent itself uses; the server doesn't
  // check who sent it, so this "just works".
  const [nameDraft, setNameDraft] = useState(name ?? '')
  // Parsec-style floating controls: collapsed to a small status-dot pill by
  // default (owner's preference -- the bar starts tucked away so it doesn't
  // cover the screen), expanded on click when the person wants the
  // Back/name/stats/status controls.
  const [panelOpen, setPanelOpen] = useState(false)
  // Whether the reliable 'input' data channel is currently open. Input rides a
  // SEPARATE peer connection from video (the native input-helper's own pc in
  // helper mode), so it can be dead while the video looks perfectly connected --
  // the exact "mouse+keyboard die but the screen streams fine" symptom. Surface
  // it in the HUD so that state is visible at a glance instead of guessed.
  const [inputReady, setInputReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<SignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  // Second, input-only PC used only when the agent advertises input-helper
  // support (pair-result.caps) -- its data channels are created by the
  // agent's native input-helper process, not by anything in this renderer.
  // When absent (older agent), input rides the video pc's own channels
  // instead, exactly as before -- see the pair-result handler below.
  const inputPcRef = useRef<RTCPeerConnection | null>(null)
  const inputChannelRef = useRef<RTCDataChannel | null>(null)
  const moveChannelRef = useRef<RTCDataChannel | null>(null)
  const lastMoveSentRef = useRef(0)
  const moveSeqRef = useRef(0)
  const { transfer, attachChannel, sendFiles, rejectDrop, cancelTransfer } =
    useFileTransferChannel()

  function commitName(): void {
    const trimmed = nameDraft.trim()
    setNameDraft(trimmed)
    clientRef.current?.send({ type: 'set-device-name', deviceId, name: trimmed })
  }

  // Stores the reliable 'input' channel AND mirrors its open/closed state into
  // inputReady for the HUD. Used at both spots that receive it (the video pc in
  // non-helper mode, and the separate input pc in helper mode) so the indicator
  // is correct regardless of which path this session negotiated.
  function trackInputChannel(channel: RTCDataChannel): void {
    inputChannelRef.current = channel
    setInputReady(channel.readyState === 'open')
    channel.addEventListener('open', () => setInputReady(true))
    channel.addEventListener('close', () => setInputReady(false))
  }

  // Remote cursor SHAPE channel (agent's input-helper -> here). Each message is
  // a semantic cursor id we apply as a CSS `cursor`, so macOS renders the real
  // shape at 0 latency and the correct hotspot -- the native video carries no
  // composited cursor (draw_mouse=0, the Parsec-style GPU win).
  function trackCursorChannel(channel: RTCDataChannel): void {
    channel.addEventListener('message', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as RemoteCursorMessage
        if (msg && typeof msg.shape === 'string') setRemoteCursor(msg.shape)
      } catch {
        /* ignore a malformed cursor frame */
      }
    })
    // If the channel closes (session torn down / re-paired), drop back to the
    // local OS cursor rather than freezing on a stale remote shape.
    channel.addEventListener('close', () => setRemoteCursor(null))
  }

  function handleDragOver(e: React.DragEvent<HTMLVideoElement>): void {
    e.preventDefault()
  }

  function handleDrop(e: React.DragEvent<HTMLVideoElement>): void {
    e.preventDefault()
    const directoryName = findDroppedDirectory(e.dataTransfer)
    if (directoryName) {
      rejectDrop(
        directoryName,
        "folders aren't supported -- zip it first and drop the .zip instead"
      )
      return
    }
    if (e.dataTransfer.files.length > 0) sendFiles(e.dataTransfer.files)
  }

  function goBack(): void {
    window.api.window.setFullScreen(false)
    clientRef.current?.close()
    pcRef.current?.close()
    inputPcRef.current?.close()
    onBack()
  }

  // The input channel is ordered/reliable by default with no backpressure
  // handling at all -- every mousemove during a fast drag (up to 60/sec)
  // got sent unconditionally. If the channel can't drain as fast as it's
  // fed (competing with the video track's own bitrate over the same
  // connection, or just a moment of network jitter), queued 'move'
  // messages pile up, and a 'down'/'up' sent chronologically *after* them
  // gets stuck behind that whole backlog -- exactly the reported symptom
  // of a drag visibly continuing for seconds after the button was
  // actually released. Only 'move' is safe to drop when backed up (a
  // newer position supersedes anything older anyway); button state and
  // key events must never be skipped, so they always send regardless.
  const INPUT_BUFFERED_AMOUNT_THRESHOLD = 16 * 1024

  function sendInput(message: RemoteInputMessage): void {
    // Moves prefer the unordered/no-retransmit channel (see
    // peerConnection.ts) -- one lost packet then costs nothing instead of
    // stalling everything behind a retransmit. Every move gets a sequence
    // number (shared counter with the reliable pre-click move below) so the
    // agent can drop any that arrive out of order. Falls back to the
    // reliable channel against an older agent that never opened one.
    if (message.t === 'move') {
      const stamped = { ...message, seq: ++moveSeqRef.current }
      const moveChannel = moveChannelRef.current
      const channel = moveChannel?.readyState === 'open' ? moveChannel : inputChannelRef.current
      if (!channel || channel.readyState !== 'open') return
      if (channel.bufferedAmount > INPUT_BUFFERED_AMOUNT_THRESHOLD) return
      channel.send(JSON.stringify(stamped))
      return
    }
    const channel = inputChannelRef.current
    if (!channel || channel.readyState !== 'open') return
    channel.send(JSON.stringify(message))
  }

  function buttonFromEvent(e: React.MouseEvent): 'left' | 'right' | 'middle' | null {
    if (e.button === 0) return 'left'
    if (e.button === 1) return 'middle'
    if (e.button === 2) return 'right'
    return null
  }

  // Mouse -> remote position. The WebRTC path derives it from the <video>'s
  // intrinsic size (videoWidth/Height) for object-fit letterboxing. In native
  // mode that element carries NO video track (videoWidth=0), so we can't read the
  // frame size from it -- instead we take the remote frame dimensions from the
  // native stats and reproduce the SAME letterbox math.
  //
  // The native surface (AVSampleBufferDisplayLayer, embed.swift) draws with
  // `.resizeAspect` -- it preserves the frame aspect and letterboxes inside the
  // element box. That box is the whole session window, which the aspect lock
  // (main setAspectRatio) only APPROXIMATELY holds at the remote's ratio, so the
  // drawn video rect can be a hair shorter/narrower than the box. Mapping the
  // pointer over the full box (the old code) then drifts symmetrically from centre
  // over the bars -- the exact "Y offset grows toward top/bottom" bug. So map over
  // the ACTUAL letterboxed video rect, mirroring videoRelativePosition's object-fit
  // handling; a pointer on the black bars returns null (no move), like the bars
  // aren't part of the remote screen.
  function relativePosition(
    el: HTMLVideoElement,
    clientX: number,
    clientY: number
  ): { x: number; y: number } | null {
    if (useNativeVideoRef.current) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vw = nativeStats?.width ?? 0
      const vh = nativeStats?.height ?? 0
      const videoAspect = vw > 0 && vh > 0 ? vw / vh : 16 / 9
      const boxAspect = rect.width / rect.height
      let contentW = rect.width
      let contentH = rect.height
      let offX = 0
      let offY = 0
      if (boxAspect > videoAspect) {
        // Pillarbox: bars left/right, video is full height.
        contentW = rect.height * videoAspect
        offX = (rect.width - contentW) / 2
      } else if (boxAspect < videoAspect) {
        // Letterbox: bars top/bottom, video is full width.
        contentH = rect.width / videoAspect
        offY = (rect.height - contentH) / 2
      }
      const x = (clientX - rect.left - offX) / contentW
      const y = (clientY - rect.top - offY) / contentH
      if (x < 0 || x > 1 || y < 0 || y > 1) return null
      return { x, y }
    }
    return videoRelativePosition(el, clientX, clientY)
  }

  function handleMouseMove(e: React.MouseEvent<HTMLVideoElement>): void {
    const now = performance.now()
    if (now - lastMoveSentRef.current < MOUSE_MOVE_THROTTLE_MS) return
    const pos = relativePosition(e.currentTarget, e.clientX, e.clientY)
    if (!pos) return
    lastMoveSentRef.current = now
    sendInput({ t: 'move', x: pos.x, y: pos.y })
  }

  function handleMouseDown(e: React.MouseEvent<HTMLVideoElement>): void {
    const button = buttonFromEvent(e)
    if (!button) return
    e.preventDefault()
    // Click position must not depend on the *unreliable* move channel: if
    // the last throttled move was dropped, the click would land wherever
    // the cursor previously was. Send the exact press position over the
    // reliable channel, ordered right before the 'down' -- stamped from the
    // same seq counter so the agent won't later apply an older in-flight
    // move on top of it.
    const pos = relativePosition(e.currentTarget, e.clientX, e.clientY)
    const channel = inputChannelRef.current
    if (pos && channel?.readyState === 'open') {
      channel.send(JSON.stringify({ t: 'move', x: pos.x, y: pos.y, seq: ++moveSeqRef.current }))
    }
    sendInput({ t: 'down', button })
  }

  function handleMouseUp(e: React.MouseEvent<HTMLVideoElement>): void {
    const button = buttonFromEvent(e)
    if (!button) return
    sendInput({ t: 'up', button })
  }

  function handleWheel(e: React.WheelEvent<HTMLVideoElement>): void {
    e.preventDefault()
    // Normalize a raw pixel delta down to roughly nut.js's "step" unit.
    sendInput({ t: 'wheel', dy: e.deltaY / 40 })
  }

  // Forwards key events to the agent while the session is mounted. Escape is
  // deliberately excluded -- it's reserved locally for disconnecting (see
  // the effect below), not meant to reach the remote machine.
  // preventDefault stops browser-native side effects (Backspace navigating
  // back, Tab shifting focus, F5 reloading, arrow keys scrolling) that
  // would otherwise fire alongside the forwarded key.
  //
  // Printable characters (including non-Latin text like Thai) go through
  // `text` + nut.js's Unicode-aware type() -- see isPrintableKey. Repeat is
  // allowed through for these so holding a key retypes it, like a real
  // keyboard. Everything else (modifiers, arrows, function keys, and any
  // Ctrl/Alt/Meta shortcut) goes through the physical-key hold path so
  // combos and held state are real on the agent's OS.
  useEffect(() => {
    // Physical keys currently held down on the agent (the keydown-path codes:
    // modifiers, arrows, shortcuts -- NOT the printable `text` path, which
    // presses+releases atomically). Used to panic-release on focus loss.
    const held = new Set<string>()
    function releaseAllHeld(): void {
      for (const code of held) sendInput({ t: 'keyup', code })
      held.clear()
    }
    function handleKeyDown(e: KeyboardEvent): void {
      // The device-name field is a real local <input> in this same
      // window -- without this check, typing into it (or into any future
      // local field) gets hijacked and forwarded to the remote machine
      // instead, making local text entry look completely broken.
      if (isEditableTarget(e.target)) return
      if (e.code === 'Escape') return
      e.preventDefault()
      if (isPrintableKey(e)) {
        sendInput({ t: 'text', text: e.key })
        return
      }
      if (e.repeat) return
      held.add(e.code)
      sendInput({ t: 'keydown', code: e.code })
    }
    function handleKeyUp(e: KeyboardEvent): void {
      if (isEditableTarget(e.target)) return
      if (e.code === 'Escape' || isPrintableKey(e)) return
      e.preventDefault()
      held.delete(e.code)
      sendInput({ t: 'keyup', code: e.code })
    }
    // When our window loses focus (Alt-Tab, clicking into Parsec, minimizing),
    // the OS delivers the physical keyup to the NEW foreground window, not us --
    // so any key held at that instant sticks "down" on the agent forever (the
    // classic "Shift stuck" -- Thai still typed via Unicode, but shortcuts broke).
    // Panic-release everything on blur / tab-hide / pagehide.
    function handleVisibility(): void {
      if (document.visibilityState === 'hidden') releaseAllHeld()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', releaseAllHeld)
    window.addEventListener('pagehide', releaseAllHeld)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', releaseAllHeld)
      window.removeEventListener('pagehide', releaseAllHeld)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // Escape while editing the name field should just blur/cancel the
      // edit, not disconnect the whole session.
      if (isEditableTarget(e.target)) return
      if (e.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.api.controllerId.get().then(setControllerId)
  }, [])

  useEffect(() => {
    if (!controllerId) return // wait for the id to load before pairing
    let cancelled = false

    async function connect(): Promise<void> {
      setStatus('connecting to signaling server')
      // House token rides every pair-request -- the server rejects the PIN
      // check outright without it. Guaranteed present by App.tsx's gate.
      const houseToken = (await window.api.houseToken.get()) ?? ''

      // Native video path opt-in resolves once per session: true only if THIS
      // build spawned the receiver helper (VIDEO_PIPELINE=native -> isReady()).
      // caps then advertise native-video; the agent must advertise it too
      // (checked in pair-result) for the native branch to actually engage.
      // Default build: isReady()=false -> caps unchanged -> every session is
      // WebRTC (the controller-side SAFETY BAR).
      const nativeReady = await window.api.videoReceiver.isReady()
      const sessionCaps = (): string[] =>
        nativeReady ? [INPUT_HELPER_CAP, NATIVE_VIDEO_CAP] : [INPUT_HELPER_CAP]

      // Native video now composites INSIDE this window (main pushes each AU into
      // the in-process render surface), so the renderer no longer positions a
      // separate window -- no render-rect / reposition plumbing at all.

      const client = await connectSignaling(resolveSignalingUrl, {
        onDisconnect: () => setStatus('disconnected, reconnecting...'),
        onReconnect: () => {
          // The server forgets pairing on disconnect, and the old peer
          // connection(s) (if any) are no longer valid -- start over.
          pcRef.current?.close()
          pcRef.current = null
          inputPcRef.current?.close()
          inputPcRef.current = null
          setActivePc(null)
          inputChannelRef.current = null
          moveChannelRef.current = null
          setInputReady(false)
          if (videoRef.current) videoRef.current.srcObject = null
          setStatus('reconnected, pairing')
          client.send({
            type: 'pair-request',
            token: houseToken,
            deviceId,
            pin,
            controllerId,
            caps: sessionCaps()
          })
        }
      })
      if (cancelled) {
        client.close()
        return
      }
      clientRef.current = client

      const transport: SignalTransport = {
        send: (message) => client.send(message),
        onMessage: (handler) => client.onMessage(handler)
      }

      // Native video signaling: the receiver helper produces the answer + ICE
      // for the video-native pc; relay them on channel:'video-native' (the
      // agent's sender consumes them, kept separate from the renderer 'video' pc
      // that still carries file transfer). Registered once per session. All
      // dormant in a default build -- these events never fire (host not spawned).
      if (nativeReady) {
        window.api.videoReceiver.onAnswer((sdp) =>
          transport.send({ type: 'sdp-answer', deviceId, sdp, channel: 'video-native' })
        )
        window.api.videoReceiver.onIce((candidate, sdpMid, sdpMLineIndex) =>
          transport.send({
            type: 'ice-candidate',
            deviceId,
            candidate,
            sdpMid,
            sdpMLineIndex,
            channel: 'video-native'
          })
        )
        window.api.videoReceiver.onFirstFrame(() => {
          setStatus('connection: connected (native video)')
        })
        window.api.videoReceiver.onStats(async (s: NativeVideoStats) => {
          // The native video pc is media-only (no SCTP), so its pc.rtt() is
          // always null. Read the network RTT off the input pc instead -- same
          // two machines / same path, and it always has a data channel so its
          // candidate-pair currentRoundTripTime is populated (mirrors useVideoStats).
          let rttMs = s.rttMs
          const ipc = inputPcRef.current
          if (rttMs == null && ipc) {
            try {
              const report = await ipc.getStats()
              report.forEach((entry) => {
                if (
                  entry.type === 'candidate-pair' &&
                  entry.nominated &&
                  typeof entry.currentRoundTripTime === 'number'
                ) {
                  rttMs = Math.round(entry.currentRoundTripTime * 1000)
                }
              })
            } catch {
              // getStats can throw if the pc closed mid-tick -- leave rtt as-is
            }
          }
          setNativeStats({
            fps: s.fps,
            width: s.width,
            height: s.height,
            kbps: s.kbps,
            processingMs: s.decodeMs ?? 0,
            rttMs,
            codec: s.codec,
            lossPct: null,
            jitterMs: s.jitterMs
          })
        })
        // BWE: the receiver's loss-based AIMD target -> relay to the agent's sender
        // on channel:'video-native' (server just forwards it; the agent forwards it
        // to the capturer stdin as 'B<kbps>'). Dormant unless native is engaged.
        window.api.videoReceiver.onBitrate((kbps) => {
          setBweTargetKbps(kbps)
          transport.send({ type: 'video-bitrate', deviceId, kbps, channel: 'video-native' })
        })
        window.api.videoReceiver.onDown(() => setStatus('native video down -- repairing'))
        window.api.window.onFullScreen((v) => setFullscreen(v))
      }

      transport.onMessage(async (raw) => {
        const parsed = SignalingMessage.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data

        if (message.type === 'pairing-pending') {
          setStatus('waiting for approval on the other computer...')
        } else if (message.type === 'pair-result') {
          if (!message.ok) {
            if (message.reason === 'unknown device id') {
              setStatus(`pairing failed: ${message.reason} (waiting for agent, retrying...)`)
              setTimeout(() => {
                transport.send({
                  type: 'pair-request',
                  token: houseToken,
                  deviceId,
                  pin,
                  controllerId,
                  caps: sessionCaps()
                })
              }, PAIR_RETRY_DELAY_MS)
              return
            }
            if (message.reason === 'incorrect pin')
              window.api.controllerMemory.clearCachedPin(deviceId)
            setStatus(`pairing failed: ${message.reason}`)
            return
          }
          // A re-pair can arrive while an old (e.g. failed) peer connection
          // is still around -- close it so we don't leak connections.
          pcRef.current?.close()
          inputPcRef.current?.close()
          inputPcRef.current = null
          setStatus('paired, waiting for video offer')

          // Whether the agent negotiated this session with its native
          // input-helper process (see docs/native-input-plan.md). Exactly
          // one of the two branches below runs -- never both -- so input is
          // never double-injected.
          const useHelper = message.caps?.includes(INPUT_HELPER_CAP) ?? false

          // Native video engages only when BOTH ends advertised it: we did
          // (nativeReady) AND the agent did (echoed in message.caps). Then the
          // agent sends its native offer on channel:'video-native' and the
          // receiver helper answers it; the renderer 'video' pc below still gets
          // created for file transfer, it just carries no video track. Default
          // build: nativeReady=false -> this stays false -> pure WebRTC video.
          const useNativeVideo = nativeReady && (message.caps?.includes(NATIVE_VIDEO_CAP) ?? false)
          useNativeVideoRef.current = useNativeVideo
          setNativeActive(useNativeVideo)
          if (useNativeVideo) {
            void window.api.videoReceiver.startSession()
            // NOTE: auto-fullscreen was tried but macOS fullscreen Spaces + the
            // separate .floating render window broke mouse routing to the <video>
            // hit-target. Left windowed (mouse works); polishing the overlay
            // compositing (fullscreen mouse, hide-on-blur, rounded corners) is
            // the native-video-plan §3a crux, deferred to a focused pass.
          }

          // The input PC itself is NOT created here -- it's built fresh from
          // whichever sdp-offer (channel:'input') actually arrives, below.
          // The helper may retry its own negotiation (closing and recreating
          // its RTCPeerConnection, see docs/native-input-plan.md's
          // helper-session-flapping addendum), sending a brand new offer with
          // fresh ICE credentials each time -- building here and then
          // reusing across retries would apply a NEW offer to an OLD,
          // no-longer-matching pc.

          const pc = createPeerConnection(
            transport,
            deviceId,
            useHelper
              ? // Helper mode: clipboard is on the input pc instead (below),
                // so it survives the agent window hiding. Only file transfer
                // (drag-and-drop, needs a visible window) stays on the video pc.
                { onFileChannel: attachChannel }
              : {
                  onInputChannel: trackInputChannel,
                  onMoveChannel: (channel) => {
                    moveChannelRef.current = channel
                  },
                  onFileChannel: attachChannel,
                  onClipboardChannel: attachClipboardChannel
                }
          )
          pcRef.current = pc
          setActivePc(pc)
          pc.onconnectionstatechange = () => {
            setStatus(`connection: ${pc.connectionState}`)
            // Deliberately not auto-fullscreening here -- a small window
            // is sometimes exactly what's wanted (e.g. keeping the remote
            // screen visible alongside other work); the OS's own
            // fullscreen control (green button / Ctrl+Cmd+F on macOS)
            // still works whenever fullscreen is actually wanted.
            if (pc.connectionState === 'connected') {
              getConnectionType(pc).then(setConnectionType)
            }
            // Covers the case where the *agent's* signaling connection drops
            // and reconnects while ours stays up the whole time -- we'd never
            // otherwise notice, since our own onReconnect only fires when OUR
            // connection drops. The agent re-registering wipes the old
            // pairing server-side, so the video link dies; re-pairing here
            // gets a fresh offer once the agent is back.
            if (pc.connectionState === 'failed' && pcRef.current === pc) {
              pc.close()
              pcRef.current = null
              inputPcRef.current?.close()
              inputPcRef.current = null
              setActivePc(null)
              inputChannelRef.current = null
              moveChannelRef.current = null
              setInputReady(false)
              setConnectionType(null)
              if (videoRef.current) videoRef.current.srcObject = null
              setTimeout(() => {
                transport.send({
                  type: 'pair-request',
                  token: houseToken,
                  deviceId,
                  pin,
                  controllerId,
                  caps: sessionCaps()
                })
              }, PAIR_RETRY_DELAY_MS)
            }
          }
          pc.ontrack = (event) => {
            // Chromium's adaptive jitter buffer holds decoded frames back
            // (easily 50-200ms worth) to smooth over network jitter --
            // great for one-way playback, pure added glass-to-glass lag
            // for remote control, where Parsec-class tools render each
            // frame the moment it's decodable. Ask for zero buffering and
            // let the occasional jitter artifact through instead; both
            // properties are Chromium-specific (the older hint is seconds,
            // the newer target is ms) so set whichever this build knows.
            const receiver = event.receiver as RTCRtpReceiver & {
              jitterBufferTarget?: number | null
              playoutDelayHint?: number | null
            }
            try {
              receiver.jitterBufferTarget = 0
            } catch {
              /* older Chromium without the attribute -- fine */
            }
            try {
              receiver.playoutDelayHint = 0
            } catch {
              /* removed in newer Chromium -- fine */
            }
            if (videoRef.current) videoRef.current.srcObject = event.streams[0]
          }
        } else if (message.type === 'sdp-offer' && message.channel === 'input') {
          // Every input-channel offer -- the first one for this session AND
          // any the helper sends after retrying its own negotiation -- gets
          // a completely fresh pc. A retried offer carries new ICE
          // credentials from a brand new RTCPeerConnection on the agent
          // side; reusing the old inputPc here would try to apply it to a
          // connection it doesn't belong to.
          inputPcRef.current?.close()
          // Clear immediately, not just on the new pc's onopen -- sendInput()
          // must never send on a channel belonging to the pc we just closed
          // in the gap before the new one's channels actually open.
          inputChannelRef.current = null
          moveChannelRef.current = null
          setInputReady(false)
          const pc = createPeerConnection(transport, deviceId, {
            channel: 'input',
            onInputChannel: trackInputChannel,
            onMoveChannel: (channel) => {
              moveChannelRef.current = channel
            },
            // Clipboard rides the input pc when the agent uses its native
            // helper, so it (like input) survives the agent window being
            // hidden -- the agent's helper process owns the other end. This
            // controller side stays in the renderer, which is fine: the
            // controller window is focused while controlling, never throttled.
            onClipboardChannel: attachClipboardChannel,
            // Remote cursor shape (native video draws no cursor of its own).
            onCursorChannel: trackCursorChannel
          })
          inputPcRef.current = pc
          await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          transport.send({ type: 'sdp-answer', deviceId, sdp: answer.sdp, channel: 'input' })
        } else if (message.type === 'sdp-offer' && message.channel === 'video-native') {
          // Native video offer -> the receiver helper (VideoToolbox), NOT the
          // WebRTC pc. Must precede the generic sdp-offer branch below, which
          // would otherwise apply it to the renderer 'video' pc.
          void window.api.videoReceiver.remoteOffer(message.sdp)
        } else if (message.type === 'ice-candidate' && message.channel === 'video-native') {
          void window.api.videoReceiver.remoteIce(
            message.candidate,
            message.sdpMid,
            message.sdpMLineIndex
          )
        } else if (message.type === 'video-sender-stats') {
          // Sender-side encode telemetry relayed from the agent (media-only pc has
          // no back-channel). Surfaced in the HUD next to the receiver numbers.
          setSenderEncodeMs(message.encodeMs)
        } else if (message.type === 'sdp-offer' && pcRef.current) {
          const pc = pcRef.current
          await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          transport.send({ type: 'sdp-answer', deviceId, sdp: answer.sdp, channel: 'video' })
        } else if (
          message.type === 'ice-candidate' &&
          message.channel === 'input' &&
          inputPcRef.current
        ) {
          await inputPcRef.current.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex ?? undefined
          })
        } else if (message.type === 'ice-candidate' && pcRef.current) {
          await pcRef.current.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex ?? undefined
          })
        }
      })

      setStatus('pairing')
      transport.send({
        type: 'pair-request',
        token: houseToken,
        deviceId,
        pin,
        controllerId,
        caps: sessionCaps()
      })
    }

    connect().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clientRef.current?.close()
      pcRef.current?.close()
      inputPcRef.current?.close()
      inputPcRef.current = null
      inputChannelRef.current = null
      moveChannelRef.current = null
      // No-op in a default build (host never spawned -> optional-chained away).
      void window.api.videoReceiver.stopSession()
      window.api.window.setFullScreen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pin, controllerId])

  // Video is up (status went past pairing into a real connection) but the input
  // channel isn't open -- the "screen streams, mouse+keyboard dead" case. Worth
  // shouting about: force the floating pill fully visible + flag it red so it's
  // obvious without expanding the panel.
  const connectionLive = status.startsWith('connection')
  const inputAlert = connectionLive && !inputReady

  return (
    <div className={`session-shell${nativeActive ? ' native-video' : ''}`}>
      <div
        className={`session-float${panelOpen ? ' is-open' : ''}${inputAlert ? ' input-alert' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      >
        {panelOpen ? (
          <div className="session-float__panel">
            <span className="session-float__grip" title="Drag to move the window">
              ⠿
            </span>
            <button className="session-float__btn" onClick={goBack}>
              ← Back
            </button>
            <input
              className="session-float__name"
              value={nameDraft}
              placeholder={deviceId}
              title={`${deviceId} · Press Esc to disconnect`}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            {/* Which video path is ACTUALLY live this session (not just the saved
                preference the sidebar bolt shows). nativeActive is true only when
                both ends negotiated native-video AND the receiver engaged; if
                native was selected but fell back to WebRTC, this reads WebRTC. */}
            <span
              className={`pipeline-badge is-${nativeActive ? 'native' : 'webrtc'}`}
              title={
                nativeActive
                  ? 'วิดีโอกำลังวิ่งผ่าน Native (ลื่นสุด)'
                  : 'วิดีโอกำลังวิ่งผ่าน WebRTC (มาตรฐาน / fallback)'
              }
            >
              {nativeActive ? '⚡ NATIVE' : 'WebRTC'}
            </span>
            {displayStats && displayStats.fps > 0 && (
              <span
                className="stats-badge"
                title="What's actually being received -- not just what was requested"
              >
                {/* Each metric is a labeled chip (dim label + bright value) so the row
                    reads at a glance and can space out cleanly when it grows in
                    fullscreen. Encode (agent, relayed) shows once the capturer reports
                    it; Decode is receiver-side and only exists on the WebRTC path
                    (AVSampleBufferDisplayLayer exposes no native decode time). */}
                {nativeActive && (
                  <span className="stat">
                    <span className="stat__k">Encode</span>
                    <span className="stat__v">
                      {senderEncodeMs != null ? `${senderEncodeMs.toFixed(1)}ms` : '—'}
                    </span>
                  </span>
                )}
                {displayStats.processingMs > 0 && (
                  <span className="stat">
                    <span className="stat__k">Decode</span>
                    <span className="stat__v">{displayStats.processingMs}ms</span>
                  </span>
                )}
                <span className="stat">
                  <span className="stat__k">Network</span>
                  <span className="stat__v">{displayStats.rttMs ?? '?'}ms</span>
                </span>
                {displayStats.jitterMs != null && (
                  <span className="stat">
                    <span className="stat__k">Jitter</span>
                    <span className="stat__v">{displayStats.jitterMs}ms</span>
                  </span>
                )}
                {displayStats.lossPct != null && (
                  <span className="stat">
                    <span className="stat__k">Loss</span>
                    <span className="stat__v">{displayStats.lossPct.toFixed(1)}%</span>
                  </span>
                )}
                <span className="stat">
                  <span className="stat__k">FPS</span>
                  <span className="stat__v">{displayStats.fps}</span>
                </span>
                <span className="stat">
                  <span className="stat__k">Res</span>
                  <span className="stat__v">
                    {displayStats.width}×{displayStats.height}
                  </span>
                </span>
                <span className="stat">
                  <span className="stat__k">Bitrate</span>
                  {/* actual → BWE target: watch auto-bitrate adapt to the link. */}
                  <span className="stat__v">
                    {(displayStats.kbps / 1000).toFixed(1)}
                    {bweTargetKbps != null ? ` → ${(bweTargetKbps / 1000).toFixed(0)}` : ''} Mbps
                  </span>
                </span>
                {displayStats.codec && (
                  <span className="stat">
                    <span className="stat__k">Codec</span>
                    <span className="stat__v">{displayStats.codec}</span>
                  </span>
                )}
              </span>
            )}
            {connectionType && (
              <span
                className="connection-type-badge"
                title="Affects file transfer speed -- relay is shared/bandwidth-limited"
              >
                {connectionType === 'relay' ? 'via relay' : 'direct connection'}
              </span>
            )}
            {connectionLive && (
              <span
                className={`session-float__input is-${inputReady ? 'ok' : 'down'}`}
                title={
                  inputReady
                    ? 'Mouse + keyboard channel is open'
                    : 'INPUT DEAD -- video is connected but the input channel never opened (native input-helper pc not established). Check %TEMP%\\input-helper.log on the agent.'
                }
              >
                ⌨ {inputReady ? 'input ✓' : 'input ✕'}
              </span>
            )}
            <StatusPill status={status} />
            <button
              className="session-float__btn session-float__collapse"
              title="Tuck away"
              onClick={() => setPanelOpen(false)}
            >
              ▴
            </button>
          </div>
        ) : (
          <button
            className="session-float__toggle"
            title={`${nameDraft || deviceId} · ${status}${
              inputAlert ? ' · INPUT DEAD (see panel)' : ''
            } · Esc = disconnect`}
            onClick={() => setPanelOpen(true)}
          >
            <span className={`session-float__dot is-${classify(status)}`} />
            {connectionLive && (
              <span
                className={`session-float__dot session-float__dot--input is-${
                  inputReady ? 'ok' : 'error'
                }`}
              />
            )}
          </button>
        )}
      </div>

      {/* App title bar for the session. Carries the app name, clears the macOS
          traffic lights, and is the one window-drag handle for the frameless
          window (in native mode the video composites behind this transparent web
          UI, so there's no other frame to grab). Sits BELOW the floating controls
          (z-index) so they stay clickable. Shown whenever windowed; hidden only in
          fullscreen (the OS provides its own chrome there). */}
      {!fullscreen && (
        <div className="session-titlebar">
          <span className="session-titlebar__app">Personal Remote</span>
          {(nameDraft || deviceId) && (
            <span className="session-titlebar__device">· {nameDraft || deviceId}</span>
          )}
        </div>
      )}

      <div className="session-video-area">
        <video
          ref={videoRef}
          autoPlay
          // Native mode: the video carries NO cursor (draw_mouse=0), so we draw
          // the remote shape natively here -- macOS renders the real cursor at
          // 0 latency + correct hotspot. Null (or WebRTC mode, whose video has
          // the cursor composited in) -> unset -> the plain local OS cursor.
          style={nativeActive && remoteCursor ? { cursor: remoteCursor } : undefined}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        />
        {!status.startsWith('connection') && (
          <span className="video-frame__empty">No video yet</span>
        )}
        <TransferStatus transfer={transfer} onCancel={cancelTransfer} />
      </div>
    </div>
  )
}
