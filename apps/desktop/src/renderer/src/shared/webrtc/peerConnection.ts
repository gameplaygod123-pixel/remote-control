// Shared RTCPeerConnection setup used by both agent and controller modes.
// Lives in the renderer because RTCPeerConnection only exists in the Chromium
// (browser) context, not in Electron's Node-based main process.

export interface SignalTransport {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
}

// Open Relay Project's free STUN+TURN (openrelay.metered.ca) used to be here
// too, meant as the TURN fallback for genuinely different-network pairs where
// direct P2P can't punch through (consumer NATs/CGNAT). Removed after a real
// packaged test's log (see input-helper/index.ts's ICE_SERVERS and
// docs/native-input-plan.md's stun-server-flapping addendum) proved it
// non-functional end to end: its STUN never got a response in 14/14 attempts
// that picked it, its TURN allocation failed every time that was logged, and
// no relay candidate ever appeared. That was diagnosed against the helper's
// node-datachannel/libjuice stack specifically, not this Chromium one, but a
// dead server is dead regardless of which ICE implementation queries it --
// no reason to keep spending gathering time on it here either. If a
// restrictive-NAT pair genuinely needs a TURN relay, this needs a real
// (ideally self-hosted, e.g. coturn on a small VPS) replacement, not another
// free service assumed to work without being verified end to end first.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export interface PeerConnectionOptions {
  // Which signaling channel this PC's ICE candidates should be tagged with
  // (see packages/protocol SignalChannel). Defaults to 'video' -- the only
  // caller that needs 'input' is the controller's second, input-only PC (see
  // ControllerSession.tsx); the agent's input PC lives in the native
  // input-helper process instead and doesn't go through this function.
  channel?: 'video' | 'input'
  // The agent is always the SDP offerer (see AgentView/ControllerSession),
  // so it's the one that must create the data channel for it to be
  // negotiated in the initial offer. The controller instead receives it via
  // ondatachannel below -- data channels are bidirectional once open
  // regardless of which side created them.
  createInputChannel?: boolean
  onInputChannel?: (channel: RTCDataChannel) => void
  // Mouse moves ride a second, unordered/no-retransmit channel: a reliable
  // ordered channel turns one lost packet into head-of-line blocking, where
  // every queued move (and the click behind it) waits out a retransmit
  // round-trip. A move that never arrives is superseded ~16ms later by the
  // next one anyway, so retransmitting stale positions only adds lag --
  // this is the same tradeoff native remote-desktop tools (Parsec) make.
  // Clicks/keys stay on the reliable "input" channel; they must never drop.
  onMoveChannel?: (channel: RTCDataChannel) => void
  // Separate channel for file transfer -- kept off the "input" channel so a
  // large file being sent doesn't head-of-line-block mouse/keyboard delivery
  // (data channels preserve order by default). Bidirectional just like
  // "input": either side can send() on it once open, regardless of which
  // side's createDataChannel call actually created it.
  createFileChannel?: boolean
  onFileChannel?: (channel: RTCDataChannel) => void
  // Clipboard text sync (see shared/clipboard/clipboardSync.ts). Its own
  // channel for the same isolation reason as file-transfer: a big pasted
  // text must never queue ahead of input events.
  onClipboardChannel?: (channel: RTCDataChannel) => void
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
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        channel: options.channel ?? 'video'
      })
    }
  }

  pc.ondatachannel = (event) => {
    if (event.channel.label === 'input') options.onInputChannel?.(event.channel)
    else if (event.channel.label === 'input-moves') options.onMoveChannel?.(event.channel)
    else if (event.channel.label === 'file-transfer') options.onFileChannel?.(event.channel)
    else if (event.channel.label === 'clipboard') options.onClipboardChannel?.(event.channel)
  }

  if (options.createInputChannel) {
    options.onInputChannel?.(pc.createDataChannel('input'))
    options.onMoveChannel?.(
      pc.createDataChannel('input-moves', { ordered: false, maxRetransmits: 0 })
    )
  }
  if (options.createFileChannel) {
    options.onFileChannel?.(pc.createDataChannel('file-transfer'))
  }
  // Piggybacks on createInputChannel (the agent is the offerer for both) --
  // no separate flag needed until some session wants input without clipboard.
  if (options.createInputChannel) {
    options.onClipboardChannel?.(pc.createDataChannel('clipboard'))
  }

  return pc
}
