import { useEffect, useRef, useState } from 'react'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'

function SourceView(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState('starting')

  useEffect(() => {
    let pc: RTCPeerConnection | undefined

    const transport: SignalTransport = {
      send: (message) => window.api.sendSignal(message),
      onMessage: (handler) => window.api.onSignal(handler)
    }

    async function start(): Promise<void> {
      pc = createPeerConnection(transport, 'loopback')
      pc.onconnectionstatechange = () => setStatus(pc!.connectionState)

      transport.onMessage(async (raw) => {
        const parsed = SignalingMessage.safeParse(raw)
        if (!parsed.success) return
        const message = parsed.data
        if (message.type === 'sdp-answer') {
          await pc!.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        } else if (message.type === 'ice-candidate') {
          await pc!.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex ?? undefined
          })
        }
      })

      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
      stream.getTracks().forEach((track) => pc!.addTrack(track, stream))
      if (videoRef.current) videoRef.current.srcObject = stream

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      transport.send({ type: 'sdp-offer', deviceId: 'loopback', sdp: offer.sdp })
    }

    start().catch((error) => setStatus(`error: ${String(error)}`))

    return () => pc?.close()
  }, [])

  return (
    <div>
      <h1>Source (capturing this screen)</h1>
      <p>connection: {status}</p>
      <video ref={videoRef} autoPlay muted style={{ width: 400 }} />
    </div>
  )
}

export default SourceView
