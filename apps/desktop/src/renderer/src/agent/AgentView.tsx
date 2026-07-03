import { useEffect, useRef, useState } from 'react'
import { connectSignaling } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL, AGENT_TOKEN, FIXED_PIN } from '../shared/config'
import StatusPill from '../shared/components/StatusPill'

const DEVICE_ID_KEY = 'remote-control-device-id'

function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const id = String(Math.floor(100_000_000 + Math.random() * 900_000_000))
  localStorage.setItem(DEVICE_ID_KEY, id)
  return id
}

function generatePin(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000))
}

function AgentView(): React.JSX.Element {
  const [deviceId] = useState(getOrCreateDeviceId)
  const [pin] = useState(() => FIXED_PIN ?? generatePin())
  const [status, setStatus] = useState('connecting to signaling server')
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let pc: RTCPeerConnection | undefined
    let client: Awaited<ReturnType<typeof connectSignaling>> | undefined
    let cancelled = false

    async function start(): Promise<void> {
      client = await connectSignaling(SIGNALING_URL, {
        onDisconnect: () => setStatus('disconnected, reconnecting...'),
        onReconnect: () => {
          // The server forgets registration/pairing on disconnect, and the
          // old peer connection (if any) is no longer valid -- start over.
          pc?.close()
          pc = undefined
          if (videoRef.current) videoRef.current.srcObject = null
          setStatus('reconnected, registering')
          client!.send({ type: 'register-agent', token: AGENT_TOKEN, deviceId, pin })
        }
      })
      if (cancelled) {
        client.close()
        return
      }
      const activeClient = client
      setStatus('registering')

      const transport: SignalTransport = {
        send: (message) => activeClient.send(message),
        onMessage: (handler) => activeClient.onMessage(handler)
      }

      transport.onMessage(async (raw) => {
        const parsed = SignalingMessage.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data

        if (message.type === 'register-result') {
          setStatus(message.ok ? 'waiting for controller to pair' : `register failed: ${message.reason}`)
        } else if (message.type === 'pair-result' && message.ok) {
          // A re-pair can arrive while an old (e.g. failed) peer connection
          // is still around -- close it so we don't leak connections.
          pc?.close()
          setStatus('paired, starting screen share')
          pc = createPeerConnection(transport, deviceId)
          pc.onconnectionstatechange = () => setStatus(`connection: ${pc!.connectionState}`)

          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
          stream.getTracks().forEach((track) => pc!.addTrack(track, stream))
          if (videoRef.current) videoRef.current.srcObject = stream

          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          transport.send({ type: 'sdp-offer', deviceId, sdp: offer.sdp })
        } else if (message.type === 'sdp-answer' && pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        } else if (message.type === 'ice-candidate' && pc) {
          await pc.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex ?? undefined
          })
        }
      })

      transport.send({ type: 'register-agent', token: AGENT_TOKEN, deviceId, pin })
    }

    start().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      pc?.close()
      client?.close()
    }
  }, [deviceId, pin])

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="app-icon">🖥️</div>
        <div>
          <div className="app-title">Agent</div>
          <div className="app-subtitle">Give these to the controller to connect</div>
        </div>
      </div>

      <div className="credential-grid">
        <div className="credential-box">
          <div className="credential-label">Device ID</div>
          <div className="credential-value">{deviceId}</div>
        </div>
        <div className="credential-box">
          <div className="credential-label">PIN</div>
          <div className="credential-value">{pin}</div>
          <div className="credential-hint">{FIXED_PIN ? 'fixed' : 'changes on restart'}</div>
        </div>
      </div>

      <StatusPill status={status} />

      <div className="video-frame">
        <video ref={videoRef} autoPlay muted />
        {!status.includes('connection') && <span className="video-frame__empty">Not sharing yet</span>}
      </div>
    </div>
  )
}

export default AgentView
