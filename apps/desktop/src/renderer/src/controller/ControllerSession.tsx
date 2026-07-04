import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL } from '../shared/config'
import StatusPill from '../shared/components/StatusPill'
import TransferStatus from '../shared/components/TransferStatus'
import { useFileTransferChannel } from '../shared/fileTransfer/useFileTransferChannel'
import { findDroppedDirectory } from '../shared/fileTransfer/fileTransferChannel'
import { getConnectionType, type ConnectionType } from '../shared/webrtc/connectionType'
import {
  RemoteInputMessage,
  isPrintableKey,
  videoRelativePosition
} from '../shared/input/inputProtocol'

// Mousemove fires far more often than the remote side needs to react to --
// this caps how frequently position updates cross the data channel without
// making cursor movement feel laggy.
const MOUSE_MOVE_THROTTLE_MS = 33

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
  onBack
}: {
  deviceId: string
  pin: string
  onBack: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState('connecting to signaling server')
  // Diagnostic for "why is a file transfer slow" -- 'relay' means traffic
  // is passing through the free TURN server (shared, bandwidth-limited)
  // rather than a direct path between the two machines.
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null)
  // Fetched from a main-process file rather than localStorage, which is
  // scoped to the Vite dev server's origin and would reset this identity
  // if the dev-server port ever shifted between runs.
  const [controllerId, setControllerId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<SignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const inputChannelRef = useRef<RTCDataChannel | null>(null)
  const lastMoveSentRef = useRef(0)
  const { transfer, attachChannel, sendFiles, rejectDrop, cancelTransfer } =
    useFileTransferChannel()

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
    onBack()
  }

  function sendInput(message: RemoteInputMessage): void {
    const channel = inputChannelRef.current
    if (channel && channel.readyState === 'open') channel.send(JSON.stringify(message))
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
      const client = await connectSignaling(SIGNALING_URL, {
        onDisconnect: () => setStatus('disconnected, reconnecting...'),
        onReconnect: () => {
          // The server forgets pairing on disconnect, and the old peer
          // connection (if any) is no longer valid -- start over.
          pcRef.current?.close()
          pcRef.current = null
          inputChannelRef.current = null
          if (videoRef.current) videoRef.current.srcObject = null
          setStatus('reconnected, pairing')
          client.send({ type: 'pair-request', deviceId, pin, controllerId })
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
                transport.send({ type: 'pair-request', deviceId, pin, controllerId })
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
          setStatus('paired, waiting for video offer')
          const pc = createPeerConnection(transport, deviceId, {
            onInputChannel: (channel) => {
              inputChannelRef.current = channel
            },
            onFileChannel: attachChannel
          })
          pcRef.current = pc
          pc.onconnectionstatechange = () => {
            setStatus(`connection: ${pc.connectionState}`)
            if (pc.connectionState === 'connected') {
              window.api.window.setFullScreen(true)
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
              inputChannelRef.current = null
              setConnectionType(null)
              if (videoRef.current) videoRef.current.srcObject = null
              setTimeout(() => {
                transport.send({ type: 'pair-request', deviceId, pin, controllerId })
              }, PAIR_RETRY_DELAY_MS)
            }
          }
          pc.ontrack = (event) => {
            if (videoRef.current) videoRef.current.srcObject = event.streams[0]
          }
        } else if (message.type === 'sdp-offer' && pcRef.current) {
          const pc = pcRef.current
          await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          transport.send({ type: 'sdp-answer', deviceId, sdp: answer.sdp })
        } else if (message.type === 'ice-candidate' && pcRef.current) {
          await pcRef.current.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex ?? undefined
          })
        }
      })

      setStatus('pairing')
      transport.send({ type: 'pair-request', deviceId, pin, controllerId })
    }

    connect().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clientRef.current?.close()
      pcRef.current?.close()
      inputChannelRef.current = null
      window.api.window.setFullScreen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pin, controllerId])

  return (
    <div className="session-shell">
      <div className="session-header">
        <button className="btn btn--ghost" onClick={goBack} style={{ padding: '8px 14px' }}>
          ← Back
        </button>
        <div>
          <div className="app-title">{deviceId}</div>
          <div className="app-subtitle">Press Esc to disconnect</div>
        </div>
        {connectionType && (
          <span
            className="connection-type-badge"
            title="Affects file transfer speed -- relay is shared/bandwidth-limited"
          >
            {connectionType === 'relay' ? 'via relay' : 'direct connection'}
          </span>
        )}
        <StatusPill status={status} />
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
