import { useEffect, useRef, useState } from 'react'
import { connectSignaling } from '../shared/signaling/signalingClient'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL, AGENT_TOKEN } from '../shared/config'
import StatusPill from '../shared/components/StatusPill'
import CopyButton from '../shared/components/CopyButton'
import UpdateBadge from '../shared/components/UpdateBadge'
import SwitchModeLink from '../shared/components/SwitchModeLink'
import TransferStatus from '../shared/components/TransferStatus'
import { useFileTransferChannel } from '../shared/fileTransfer/useFileTransferChannel'
import { findDroppedDirectory } from '../shared/fileTransfer/fileTransferChannel'
import { getConnectionType, type ConnectionType } from '../shared/webrtc/connectionType'
import type { RemoteInputMessage } from '../shared/input/inputProtocol'

// Cached after the first remote input message -- the agent's screen doesn't
// resize mid-session, and re-querying nut.js on every mousemove would add
// needless latency to the hottest path.
let cachedScreenSize: { width: number; height: number } | null = null

async function handleRemoteInput(message: RemoteInputMessage): Promise<void> {
  switch (message.t) {
    case 'move': {
      if (!cachedScreenSize) cachedScreenSize = await window.api.input.getScreenSize()
      await window.api.input.move(
        Math.round(message.x * cachedScreenSize.width),
        Math.round(message.y * cachedScreenSize.height)
      )
      break
    }
    case 'down':
    case 'up':
      await window.api.input.mouseButton(message.button, message.t === 'down')
      break
    case 'wheel':
      await window.api.input.scroll(message.dy)
      break
    case 'keydown':
    case 'keyup':
      await window.api.input.key(message.code, message.t === 'keydown')
      break
    case 'text':
      await window.api.input.type(message.text)
      break
  }
}

const THUMBNAIL_INTERVAL_MS = 4000

function AgentView(): React.JSX.Element {
  // deviceId/name/pin all live in a main-process file (see agentIdentity.ts)
  // rather than renderer localStorage or a VITE_PIN env var -- the latter
  // meant a real PIN sitting in plaintext inside a launcher script that
  // gets committed to git. Null until the initial IPC round-trip resolves.
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [pin, setPinValue] = useState<string | null>(null)
  const [pinDraft, setPinDraft] = useState('')
  const [pinSaved, setPinSaved] = useState(false)
  const [status, setStatus] = useState('connecting to signaling server')
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null)
  const [incomingRequest, setIncomingRequest] = useState(false)
  const [pendingControllerId, setPendingControllerId] = useState<string | null>(null)
  const [trustedList, setTrustedList] = useState<{ id: string; trustedAt: number }[]>([])
  const [name, setName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const clientRef = useRef<Awaited<ReturnType<typeof connectSignaling>> | null>(null)
  const nameRef = useRef(name)
  nameRef.current = name
  const { transfer, attachChannel, sendFiles, rejectDrop } = useFileTransferChannel()

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault()
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault()
    const directoryName = findDroppedDirectory(e.dataTransfer)
    if (directoryName) {
      rejectDrop(
        directoryName,
        "folders aren't supported -- zip it first and drop the .zip instead"
      )
      return
    }
    if (e.dataTransfer.files.length > 0) sendFiles(e.dataTransfer.files)
  }

  useEffect(() => {
    Promise.all([
      window.api.agentIdentity.getDeviceId(),
      window.api.agentIdentity.getName(),
      window.api.agentIdentity.getPin()
    ]).then(([id, storedName, storedPin]) => {
      setDeviceId(id)
      setName(storedName)
      setNameDraft(storedName)
      setPinValue(storedPin)
      setPinDraft(storedPin)
    })
  }, [])

  // Renaming re-sends only a lightweight set-device-name message, never a
  // fresh register-agent -- re-registering would reset the whole record on
  // the server (including who's currently paired), disconnecting an active
  // session just to change a display name.
  function commitName(): void {
    const trimmed = nameDraft.trim()
    setName(trimmed)
    setNameDraft(trimmed)
    window.api.agentIdentity.setName(trimmed)
    clientRef.current?.send({ type: 'set-device-name', deviceId, name: trimmed })
  }

  // Unlike renaming, a PIN change is a dependency of the connect effect
  // below, so updating it here tears down and re-establishes the signaling
  // connection with a fresh register-agent -- the server only checks the
  // PIN hash it captured at register time, so anything less would save the
  // new PIN locally while the server kept accepting the old one. This also
  // drops any currently-paired session, which is the right behavior for a
  // credential-rotation action.
  function broadcastPinChange(nextPin: string): void {
    setPinValue(nextPin)
    setPinDraft(nextPin)
    setPinSaved(true)
    setTimeout(() => setPinSaved(false), 2000)
  }

  function commitPinDraft(): void {
    const trimmed = pinDraft.trim()
    if (!trimmed || trimmed === pin) {
      setPinDraft(pin ?? '')
      return
    }
    window.api.agentIdentity.setPin(trimmed)
    broadcastPinChange(trimmed)
  }

  async function handleRegeneratePin(): Promise<void> {
    const nextPin = await window.api.agentIdentity.regeneratePin()
    broadcastPinChange(nextPin)
  }

  // A correct PIN alone no longer opens the session -- the person at this
  // machine has to explicitly let the connection through, once. Accepting
  // remembers the controller so it skips this prompt next time (see the
  // connection-request handler below) -- otherwise every reconnect from
  // the same, already-trusted Mac would ask again, which given how often
  // this app already auto-reconnects would get old fast.
  async function handleAccept(): Promise<void> {
    setIncomingRequest(false)
    if (pendingControllerId) {
      await window.api.trusted.trust(pendingControllerId)
      setTrustedList(await window.api.trusted.list())
    }
    setPendingControllerId(null)
    clientRef.current?.send({ type: 'connection-response', deviceId, accept: true })
  }

  function handleReject(): void {
    setIncomingRequest(false)
    setPendingControllerId(null)
    setStatus('waiting for controller to pair')
    clientRef.current?.send({ type: 'connection-response', deviceId, accept: false })
  }

  async function handleRevoke(id: string): Promise<void> {
    await window.api.trusted.revoke(id)
    setTrustedList(await window.api.trusted.list())
  }

  useEffect(() => {
    window.api.trusted.list().then(setTrustedList)
  }, [])

  useEffect(() => {
    if (!deviceId || !pin) return undefined // wait for identity to load from disk
    // Narrowed copies for use inside nested closures below -- TS doesn't
    // carry the null-check narrowing above through into those callbacks.
    const agentDeviceId = deviceId
    const agentPin = pin

    let pc: RTCPeerConnection | undefined
    let client: Awaited<ReturnType<typeof connectSignaling>> | undefined
    let cancelled = false

    // Low-res device-list preview -- paused while a real call is connected
    // (pc.connectionState === 'connected') since the controller already has
    // full live video at that point and there's no point spending capture
    // time/bandwidth on a thumbnail nobody's looking at.
    const thumbnailInterval = setInterval(async () => {
      if (cancelled || pc?.connectionState === 'connected') return
      const image = await window.api.agent.captureThumbnail()
      if (image) client?.send({ type: 'device-thumbnail', deviceId: agentDeviceId, image })
    }, THUMBNAIL_INTERVAL_MS)

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
          client!.send({
            type: 'register-agent',
            token: AGENT_TOKEN,
            deviceId: agentDeviceId,
            pin: agentPin,
            name: nameRef.current
          })
        }
      })
      clientRef.current = client
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
          setStatus(
            message.ok ? 'waiting for controller to pair' : `register failed: ${message.reason}`
          )
        } else if (message.type === 'connection-request') {
          if (await window.api.trusted.isTrusted(message.controllerId)) {
            transport.send({ type: 'connection-response', deviceId: agentDeviceId, accept: true })
          } else {
            setPendingControllerId(message.controllerId)
            setIncomingRequest(true)
            setStatus('incoming connection request')
            // The window may be hidden in the tray (auto-started at boot,
            // or minimized earlier) -- an untrusted connection needs a
            // human decision, so it has to actually be seen.
            window.api.window.show()
          }
        } else if (message.type === 'pair-result' && message.ok) {
          // A re-pair can arrive while an old (e.g. failed) peer connection
          // is still around -- close it so we don't leak connections.
          setIncomingRequest(false)
          pc?.close()
          setStatus('paired, starting screen share')
          pc = createPeerConnection(transport, agentDeviceId, {
            createInputChannel: true,
            onInputChannel: (channel) => {
              channel.onmessage = (event) => {
                handleRemoteInput(JSON.parse(event.data) as RemoteInputMessage)
              }
            },
            createFileChannel: true,
            onFileChannel: attachChannel
          })
          pc.onconnectionstatechange = () => {
            setStatus(`connection: ${pc!.connectionState}`)
            if (pc!.connectionState === 'connected') getConnectionType(pc!).then(setConnectionType)
            else if (pc!.connectionState === 'failed' || pc!.connectionState === 'closed') {
              setConnectionType(null)
            }
          }

          // frameRate: without an explicit ask, Chromium's screen-capture
          // default can be quite conservative (sometimes ~5fps), which reads
          // as "laggy" even though the connection itself is fine.
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30, max: 30 } }
          })
          const [videoTrack] = stream.getVideoTracks()
          // Tells the encoder to prioritize smooth motion (cursor movement,
          // scrolling) over per-frame sharpness -- the right tradeoff for a
          // remote-control session, not a screen-recording.
          if (videoTrack) videoTrack.contentHint = 'motion'

          stream.getTracks().forEach((track) => {
            const sender = pc!.addTrack(track, stream)
            if (track.kind !== 'video') return
            // WebRTC's default bandwidth estimate ramps up slowly and starts
            // conservative, especially over a TURN relay -- a stale/blurry
            // low-bitrate stream is easy to misread as network lag. Raising
            // the ceiling lets it settle on a sharper, more responsive
            // stream sooner once real available bandwidth allows it.
            const params = sender.getParameters()
            if (!params.encodings?.length) params.encodings = [{}]
            params.encodings[0].maxBitrate = 4_000_000
            sender.setParameters(params).catch(() => {})
          })
          if (videoRef.current) videoRef.current.srcObject = stream

          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          transport.send({ type: 'sdp-offer', deviceId: agentDeviceId, sdp: offer.sdp })
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

      transport.send({
        type: 'register-agent',
        token: AGENT_TOKEN,
        deviceId: agentDeviceId,
        pin: agentPin,
        name: nameRef.current
      })
    }

    start().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clearInterval(thumbnailInterval)
      clientRef.current = null
      pc?.close()
      client?.close()
    }
  }, [deviceId, pin, attachChannel])

  if (deviceId === null || pin === null) {
    return (
      <div className="agent-shell">
        <p className="app-subtitle">Loading...</p>
      </div>
    )
  }

  return (
    <div className="agent-shell" onDragOver={handleDragOver} onDrop={handleDrop}>
      <div className="agent-titlebar">
        <div className="agent-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="agent-titletext">Personal Remote — Agent</div>
      </div>

      <div className="agent-body">
        <div className="app-header">
          <div className="app-icon">🖥️</div>
          <div>
            <div className="app-title">Personal Remote Agent</div>
            <div className="app-subtitle">Give these to the controller to connect</div>
          </div>
        </div>

        {incomingRequest && (
          <div className="connection-request">
            <div className="connection-request__title">Incoming connection request</div>
            <p className="connection-request__body">
              Someone entered the correct PIN and wants to connect to this computer.
            </p>
            <div className="connection-request__actions">
              <button className="btn" onClick={handleAccept}>
                Accept
              </button>
              <button className="btn btn--ghost" onClick={handleReject}>
                Reject
              </button>
            </div>
          </div>
        )}

        <div className="field-group">
          <label className="field-label">Device name</label>
          <input
            className="field-input"
            placeholder="e.g. Bedroom PC"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>

        <div className="credential-grid">
          <div className="credential-box">
            <div className="credential-label">Device ID</div>
            <div className="credential-value-row">
              <span className="credential-value">{deviceId}</span>
              <CopyButton value={deviceId} />
            </div>
          </div>
          <div className="credential-box">
            <div className="credential-label">PIN</div>
            <div className="credential-value-row">
              <input
                className="field-input credential-pin-input"
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value)}
                onBlur={commitPinDraft}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <CopyButton value={pin} />
            </div>
            <div className="credential-hint">
              {pinSaved ? 'saved' : 'set your own, or '}
              {!pinSaved && (
                <button className="credential-pin-regenerate" onClick={handleRegeneratePin}>
                  generate a new one
                </button>
              )}
            </div>
          </div>
        </div>

        {connectionType && (
          <span
            className="connection-type-badge"
            title="Affects file transfer speed -- relay is shared/bandwidth-limited"
          >
            {connectionType === 'relay' ? 'via relay' : 'direct connection'}
          </span>
        )}
        <StatusPill status={status} />

        <div className="video-frame">
          <video ref={videoRef} autoPlay muted />
          {!status.includes('connection') && (
            <span className="video-frame__empty">Not sharing yet</span>
          )}
        </div>

        <TransferStatus transfer={transfer} />

        {trustedList.length > 0 && (
          <div className="field-group">
            <label className="field-label">Trusted devices (skip the approval prompt)</label>
            <div className="trusted-list">
              {trustedList.map((c) => (
                <div key={c.id} className="trusted-list__row">
                  <span className="trusted-list__id">{c.id.slice(0, 8)}</span>
                  <span className="trusted-list__date">
                    trusted {new Date(c.trustedAt).toLocaleDateString()}
                  </span>
                  <button
                    className="trusted-list__revoke"
                    onClick={() => handleRevoke(c.id)}
                    title="Forget this device -- it'll need approval again next time"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="agent-footer">
        <SwitchModeLink />
        <UpdateBadge />
      </div>
    </div>
  )
}

export default AgentView
