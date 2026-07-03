import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL, AUTO_CONNECT_DEVICE_ID, FIXED_PIN } from '../shared/config'
import StatusPill from '../shared/components/StatusPill'

// After a network drop -- or the agent machine being restarted by hand,
// which can take an arbitrarily long time -- the controller and agent
// reconnect independently with no ordering guarantee. Retry indefinitely on
// "unknown device id" specifically (not on a wrong PIN -- that's a real
// error, not a timing/availability issue) rather than giving up on what's
// virtually always just the agent not being back yet.
const PAIR_RETRY_DELAY_MS = 3000

function ControllerView(): React.JSX.Element {
  const [deviceId, setDeviceId] = useState(AUTO_CONNECT_DEVICE_ID ?? '')
  const [pin, setPin] = useState(FIXED_PIN ?? '')
  const [status, setStatus] = useState('not connected')
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<SignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)

  async function connect(
    targetDeviceId: string,
    targetPin: string,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
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
        client.send({ type: 'pair-request', deviceId: targetDeviceId, pin: targetPin })
      }
    })
    if (isCancelled()) {
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
              transport.send({ type: 'pair-request', deviceId: targetDeviceId, pin: targetPin })
            }, PAIR_RETRY_DELAY_MS)
            return
          }
          setStatus(`pairing failed: ${message.reason}`)
          return
        }
        // A re-pair can arrive while an old (e.g. failed) peer connection
        // is still around -- close it so we don't leak connections.
        pcRef.current?.close()
        setStatus('paired, waiting for video offer')
        const pc = createPeerConnection(transport, targetDeviceId)
        pcRef.current = pc
        pc.onconnectionstatechange = () => {
          setStatus(`connection: ${pc.connectionState}`)
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
              transport.send({ type: 'pair-request', deviceId: targetDeviceId, pin: targetPin })
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
        transport.send({ type: 'sdp-answer', deviceId: targetDeviceId, sdp: answer.sdp })
      } else if (message.type === 'ice-candidate' && pcRef.current) {
        await pcRef.current.addIceCandidate({
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex ?? undefined
        })
      }
    })

    setStatus('pairing')
    transport.send({ type: 'pair-request', deviceId: targetDeviceId, pin: targetPin })
  }

  useEffect(() => {
    if (!(AUTO_CONNECT_DEVICE_ID && FIXED_PIN)) return
    let cancelled = false
    connect(AUTO_CONNECT_DEVICE_ID, FIXED_PIN, () => cancelled).catch((error) =>
      setStatus(`error: ${String(error)}`)
    )
    return () => {
      cancelled = true
      clientRef.current?.close()
      pcRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app-shell app-shell--wide">
      <div className="app-header">
        <div className="app-icon">🎮</div>
        <div>
          <div className="app-title">Controller</div>
          <div className="app-subtitle">Connect to a remote agent</div>
        </div>
      </div>

      <div className="credential-grid">
        <div className="field-group">
          <label className="field-label" htmlFor="device-id">
            Device ID
          </label>
          <input
            id="device-id"
            className="field-input"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            placeholder="123456789"
          />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="pin">
            PIN
          </label>
          <input
            id="pin"
            className="field-input"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="123456"
          />
        </div>
      </div>

      <button className="btn" onClick={() => connect(deviceId, pin)} style={{ alignSelf: 'flex-start' }}>
        Connect
      </button>

      <StatusPill status={status} />

      <div className="video-frame">
        <video ref={videoRef} autoPlay />
        {!status.startsWith('connection') && <span className="video-frame__empty">No video yet</span>}
      </div>
    </div>
  )
}

export default ControllerView
