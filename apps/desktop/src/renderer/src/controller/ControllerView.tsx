import { useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL } from '../shared/config'

function ControllerView(): React.JSX.Element {
  const [deviceId, setDeviceId] = useState('')
  const [pin, setPin] = useState('')
  const [status, setStatus] = useState('not connected')
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<SignalingClient | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)

  async function connect(): Promise<void> {
    setStatus('connecting to signaling server')
    const client = await connectSignaling(SIGNALING_URL)
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
          setStatus(`pairing failed: ${message.reason}`)
          return
        }
        setStatus('paired, waiting for video offer')
        const pc = createPeerConnection(transport, deviceId)
        pcRef.current = pc
        pc.onconnectionstatechange = () => setStatus(`connection: ${pc.connectionState}`)
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

  return (
    <div style={{ padding: 16 }}>
      <h1>Controller</h1>
      <p>
        Device ID:{' '}
        <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="123456789" />
      </p>
      <p>
        PIN: <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="123456" />
      </p>
      <button onClick={connect}>Connect</button>
      <p>status: {status}</p>
      <video ref={videoRef} autoPlay style={{ width: 800 }} />
    </div>
  )
}

export default ControllerView
