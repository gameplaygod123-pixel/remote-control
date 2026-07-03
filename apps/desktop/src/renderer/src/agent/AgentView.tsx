import { useEffect, useRef, useState } from 'react'
import { connectSignaling } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL, AGENT_TOKEN, FIXED_PIN } from '../shared/config'

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
    let cancelled = false

    async function start(): Promise<void> {
      const client = await connectSignaling(SIGNALING_URL)
      if (cancelled) return
      setStatus('registering')

      const transport: SignalTransport = {
        send: (message) => client.send(message),
        onMessage: (handler) => client.onMessage(handler)
      }

      transport.onMessage(async (raw) => {
        const parsed = SignalingMessage.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data

        if (message.type === 'register-result') {
          setStatus(message.ok ? 'waiting for controller to pair' : `register failed: ${message.reason}`)
        } else if (message.type === 'pair-result' && message.ok) {
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
    }
  }, [deviceId, pin])

  return (
    <div style={{ padding: 16 }}>
      <h1>Agent</h1>
      <p>Give these to the controller to connect:</p>
      <p>
        Device ID: <strong>{deviceId}</strong>
      </p>
      <p>
        PIN: <strong>{pin}</strong> {FIXED_PIN ? '(fixed)' : '(changes each time this app restarts)'}
      </p>
      <p>status: {status}</p>
      <video ref={videoRef} autoPlay muted style={{ width: 300 }} />
    </div>
  )
}

export default AgentView
