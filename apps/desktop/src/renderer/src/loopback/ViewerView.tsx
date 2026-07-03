import { useEffect, useRef, useState } from 'react'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'

function ViewerView(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState('waiting for offer')

  useEffect(() => {
    const transport: SignalTransport = {
      send: (message) => window.api.sendSignal(message),
      onMessage: (handler) => window.api.onSignal(handler)
    }

    const pc = createPeerConnection(transport, 'loopback')
    pc.onconnectionstatechange = () => setStatus(pc.connectionState)

    pc.ontrack = (event) => {
      if (videoRef.current) videoRef.current.srcObject = event.streams[0]
    }

    transport.onMessage(async (raw) => {
      const parsed = SignalingMessage.safeParse(raw)
      if (!parsed.success) return
      const message = parsed.data
      if (message.type === 'sdp-offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        transport.send({ type: 'sdp-answer', deviceId: 'loopback', sdp: answer.sdp })
      } else if (message.type === 'ice-candidate') {
        await pc.addIceCandidate({
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex ?? undefined
        })
      }
    })

    return () => pc.close()
  }, [])

  return (
    <div>
      <h1>Viewer (remote screen)</h1>
      <p>connection: {status}</p>
      <video ref={videoRef} autoPlay style={{ width: 800 }} />
    </div>
  )
}

export default ViewerView
