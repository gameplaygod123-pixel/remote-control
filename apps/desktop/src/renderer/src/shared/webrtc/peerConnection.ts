// Shared RTCPeerConnection setup used by both agent and controller modes.
// Lives in the renderer because RTCPeerConnection only exists in the Chromium
// (browser) context, not in Electron's Node-based main process.

export interface SignalTransport {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
}

// Free-tier STUN for now; Phase 4 adds a free TURN relay for hard-NAT cases.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export function createPeerConnection(
  transport: SignalTransport,
  deviceId: string
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      transport.send({
        type: 'ice-candidate',
        deviceId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      })
    }
  }

  return pc
}
