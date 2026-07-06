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
import { useVideoStats } from '../shared/webrtc/useVideoStats'
import { attachClipboardChannel } from '../shared/clipboard/clipboardSync'
import {
  RemoteInputMessage,
  isPrintableKey,
  isEditableTarget,
  videoRelativePosition
} from '../shared/input/inputProtocol'
import { INPUT_HELPER_CAP } from '../shared/input/capabilities'

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

  function handleMouseMove(e: React.MouseEvent<HTMLVideoElement>): void {
    const now = performance.now()
    if (now - lastMoveSentRef.current < MOUSE_MOVE_THROTTLE_MS) return
    const pos = videoRelativePosition(e.currentTarget, e.clientX, e.clientY)
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
    const pos = videoRelativePosition(e.currentTarget, e.clientX, e.clientY)
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
      sendInput({ t: 'keydown', code: e.code })
    }
    function handleKeyUp(e: KeyboardEvent): void {
      if (isEditableTarget(e.target)) return
      if (e.code === 'Escape' || isPrintableKey(e)) return
      e.preventDefault()
      sendInput({ t: 'keyup', code: e.code })
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
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
          if (videoRef.current) videoRef.current.srcObject = null
          setStatus('reconnected, pairing')
          client.send({
            type: 'pair-request',
            token: houseToken,
            deviceId,
            pin,
            controllerId,
            caps: [INPUT_HELPER_CAP]
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
                  caps: [INPUT_HELPER_CAP]
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
                  onInputChannel: (channel) => {
                    inputChannelRef.current = channel
                  },
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
              setConnectionType(null)
              if (videoRef.current) videoRef.current.srcObject = null
              setTimeout(() => {
                transport.send({
                  type: 'pair-request',
                  token: houseToken,
                  deviceId,
                  pin,
                  controllerId,
                  caps: [INPUT_HELPER_CAP]
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
          const pc = createPeerConnection(transport, deviceId, {
            channel: 'input',
            onInputChannel: (channel) => {
              inputChannelRef.current = channel
            },
            onMoveChannel: (channel) => {
              moveChannelRef.current = channel
            },
            // Clipboard rides the input pc when the agent uses its native
            // helper, so it (like input) survives the agent window being
            // hidden -- the agent's helper process owns the other end. This
            // controller side stays in the renderer, which is fine: the
            // controller window is focused while controlling, never throttled.
            onClipboardChannel: attachClipboardChannel
          })
          inputPcRef.current = pc
          await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          transport.send({ type: 'sdp-answer', deviceId, sdp: answer.sdp, channel: 'input' })
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
        caps: [INPUT_HELPER_CAP]
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
      window.api.window.setFullScreen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pin, controllerId])

  return (
    <div className="session-shell">
      <div className={`session-float${panelOpen ? ' is-open' : ''}`}>
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
            {videoStats && videoStats.fps > 0 && (
              <span
                className="connection-type-badge"
                title="What's actually being received -- not just what was requested"
              >
                Decode {videoStats.processingMs}ms · Network {videoStats.rttMs ?? '?'}ms ·{' '}
                {videoStats.jitterMs != null ? `Jitter ${videoStats.jitterMs}ms · ` : ''}
                {videoStats.lossPct != null ? `Loss ${videoStats.lossPct.toFixed(1)}% · ` : ''}
                {videoStats.fps}fps · {videoStats.width}×{videoStats.height} ·{' '}
                {(videoStats.kbps / 1000).toFixed(1)} Mbps
                {videoStats.codec ? ` · ${videoStats.codec}` : ''}
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
            title={`${nameDraft || deviceId} · ${status} · Esc = disconnect`}
            onClick={() => setPanelOpen(true)}
          >
            <span className={`session-float__dot is-${classify(status)}`} />
          </button>
        )}
      </div>

      <div className="session-video-area">
        <video
          ref={videoRef}
          autoPlay
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
