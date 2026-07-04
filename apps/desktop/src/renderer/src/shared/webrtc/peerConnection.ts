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
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

export interface PeerConnectionOptions {
  // The agent is always the SDP offerer (see AgentView/ControllerSession),
  // so it's the one that must create the data channel for it to be
  // negotiated in the initial offer. The controller instead receives it via
  // ondatachannel below -- data channels are bidirectional once open
  // regardless of which side created them.
  createInputChannel?: boolean
  onInputChannel?: (channel: RTCDataChannel) => void
  // Separate channel for file transfer -- kept off the "input" channel so a
  // large file being sent doesn't head-of-line-block mouse/keyboard delivery
  // (data channels preserve order by default). Bidirectional just like
  // "input": either side can send() on it once open, regardless of which
  // side's createDataChannel call actually created it.
  createFileChannel?: boolean
  onFileChannel?: (channel: RTCDataChannel) => void
}

export function createPeerConnection(
  transport: SignalTransport,
  deviceId: string,
  options: PeerConnectionOptions = {}
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

  pc.ondatachannel = (event) => {
    if (event.channel.label === 'input') options.onInputChannel?.(event.channel)
    else if (event.channel.label === 'file-transfer') options.onFileChannel?.(event.channel)
  }

  if (options.createInputChannel) {
    options.onInputChannel?.(pc.createDataChannel('input'))
  }
  if (options.createFileChannel) {
    options.onFileChannel?.(pc.createDataChannel('file-transfer'))
  }

  return pc
}
