// Shared RTCPeerConnection setup used by both agent and controller modes.
// Lives in the renderer because RTCPeerConnection only exists in the Chromium
// (browser) context, not in Electron's Node-based main process.

export interface SignalTransport {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
}

// Free-tier STUN + TURN. TURN (Open Relay Project's public demo relay) matters
// once the two machines are on genuinely different networks: consumer
// NATs/CGNAT often can't do direct P2P, so without a relay the connection
// just hangs instead of falling back. Fine for personal use; swap for a
// self-hosted coturn on a small VPS later if this free tier proves flaky.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

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
