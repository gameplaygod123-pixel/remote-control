import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL } from '../shared/config'
import { clearCachedPin } from '../shared/devicePins'
import StatusPill from '../shared/components/StatusPill'

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
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<SignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)

  function goBack(): void {
    window.api.window.setFullScreen(false)
    clientRef.current?.close()
    pcRef.current?.close()
    onBack()
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
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
          if (videoRef.current) videoRef.current.srcObject = null
          setStatus('reconnected, pairing')
          client.send({ type: 'pair-request', deviceId, pin })
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

        if (message.type === 'pair-result') {
          if (!message.ok) {
            if (message.reason === 'unknown device id') {
              setStatus(`pairing failed: ${message.reason} (waiting for agent, retrying...)`)
              setTimeout(() => {
                transport.send({ type: 'pair-request', deviceId, pin })
              }, PAIR_RETRY_DELAY_MS)
              return
            }
            if (message.reason === 'incorrect pin') clearCachedPin(deviceId)
            setStatus(`pairing failed: ${message.reason}`)
            return
          }
          // A re-pair can arrive while an old (e.g. failed) peer connection
          // is still around -- close it so we don't leak connections.
          pcRef.current?.close()
          setStatus('paired, waiting for video offer')
          const pc = createPeerConnection(transport, deviceId)
          pcRef.current = pc
          pc.onconnectionstatechange = () => {
            setStatus(`connection: ${pc.connectionState}`)
            if (pc.connectionState === 'connected') {
              window.api.window.setFullScreen(true)
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
              if (videoRef.current) videoRef.current.srcObject = null
              setTimeout(() => {
                transport.send({ type: 'pair-request', deviceId, pin })
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
      transport.send({ type: 'pair-request', deviceId, pin })
    }

    connect().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clientRef.current?.close()
      pcRef.current?.close()
      window.api.window.setFullScreen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pin])

  return (
    <div className="app-shell app-shell--wide">
      <div className="app-header">
        <button className="btn btn--ghost" onClick={goBack} style={{ padding: '8px 14px' }}>
          ← Back
        </button>
        <div>
          <div className="app-title">{deviceId}</div>
          <div className="app-subtitle">Press Esc to disconnect</div>
        </div>
      </div>

      <StatusPill status={status} />

      <div className="video-frame">
        <video ref={videoRef} autoPlay />
        {!status.startsWith('connection') && <span className="video-frame__empty">No video yet</span>}
      </div>
    </div>
  )
}
