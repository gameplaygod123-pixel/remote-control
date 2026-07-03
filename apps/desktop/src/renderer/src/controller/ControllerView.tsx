import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL, AUTO_CONNECT_DEVICE_ID, FIXED_PIN } from '../shared/config'

// After a network drop, the controller and agent reconnect independently --
// there's no guarantee the agent finishes re-registering before the
// controller re-sends its pair-request. Retry a few times on "unknown
// device id" specifically (not on a wrong PIN -- that's a real error, not a
// timing race) rather than failing permanently on what's likely just a race.
const PAIR_RETRY_DELAY_MS = 2000
const PAIR_RETRY_MAX_ATTEMPTS = 15

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

    let pairRetries = 0

    transport.onMessage(async (raw) => {
      const parsed = SignalingMessage.safeParse(raw)
      if (!parsed.success) return
      const message = parsed.data

      if (message.type === 'pair-result') {
        if (!message.ok) {
          if (message.reason === 'unknown device id' && pairRetries < PAIR_RETRY_MAX_ATTEMPTS) {
            pairRetries += 1
            setStatus(`pairing failed: ${message.reason} (retrying...)`)
            setTimeout(() => {
              transport.send({ type: 'pair-request', deviceId: targetDeviceId, pin: targetPin })
            }, PAIR_RETRY_DELAY_MS)
            return
          }
          setStatus(`pairing failed: ${message.reason}`)
          return
        }
        pairRetries = 0
        setStatus('paired, waiting for video offer')
        const pc = createPeerConnection(transport, targetDeviceId)
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
    <div style={{ padding: 16 }}>
      <h1>Controller</h1>
      <p>
        Device ID:{' '}
        <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="123456789" />
      </p>
      <p>
        PIN: <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="123456" />
      </p>
      <button onClick={() => connect(deviceId, pin)}>Connect</button>
      <p>status: {status}</p>
      <video ref={videoRef} autoPlay style={{ width: 800 }} />
    </div>
  )
}

export default ControllerView
