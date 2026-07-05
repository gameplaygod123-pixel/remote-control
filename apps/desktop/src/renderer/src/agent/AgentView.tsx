import { useEffect, useRef, useState } from 'react'
import { connectSignaling } from '../shared/signaling/signalingClient'
import { resolveSignalingUrl } from '../shared/signaling/resolveSignalingUrl'
import { createPeerConnection, SignalTransport } from '../shared/webrtc/peerConnection'
import { SignalingMessage } from '../shared/protocol'
import TokenSetupView from '../setup/TokenSetupView'
import StatusPill from '../shared/components/StatusPill'
import TitleBar from '../shared/components/TitleBar'
import CopyButton from '../shared/components/CopyButton'
import UpdateBadge from '../shared/components/UpdateBadge'
import SwitchModeLink from '../shared/components/SwitchModeLink'
import TransferStatus from '../shared/components/TransferStatus'
import { useFileTransferChannel } from '../shared/fileTransfer/useFileTransferChannel'
import { findDroppedDirectory } from '../shared/fileTransfer/fileTransferChannel'
import { getConnectionType, type ConnectionType } from '../shared/webrtc/connectionType'
import { useVideoStats } from '../shared/webrtc/useVideoStats'
import { attachClipboardChannel } from '../shared/clipboard/clipboardSync'
import type { RemoteInputMessage } from '../shared/input/inputProtocol'
import { INPUT_HELPER_CAP } from '../shared/input/capabilities'

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

// Input messages now arrive on two channels (reliable "input" + unordered
// "input-moves"), and each injection is an async IPC hop -- so injection
// needs its own serialization instead of relying on channel order. This
// queue (a) keeps move->down ordering intact by draining everything through
// one loop, (b) collapses consecutive queued moves into just the newest one
// so a burst can never build a backlog of stale positions (the old cause of
// the cursor visibly "replaying" a drag), and (c) uses the moves' sequence
// numbers to drop any move the unordered channel delivered late, rather
// than jerking the cursor backwards. State is module-level like
// cachedScreenSize; resetInputQueue() clears it when a new session's
// channels attach (a new controller restarts its seq counter at 0).
let inputQueue: RemoteInputMessage[] = []
let inputDraining = false
let lastMoveSeq = -1

function resetInputQueue(): void {
  inputQueue = []
  lastMoveSeq = -1
}

function enqueueRemoteInput(message: RemoteInputMessage): void {
  if (message.t === 'move') {
    if (message.seq !== undefined) {
      if (message.seq <= lastMoveSeq) return // out-of-order stale move
      lastMoveSeq = message.seq
    }
    const last = inputQueue[inputQueue.length - 1]
    if (last?.t === 'move') {
      inputQueue[inputQueue.length - 1] = message // newest position supersedes
    } else {
      inputQueue.push(message)
    }
  } else {
    inputQueue.push(message)
  }
  if (inputDraining) return
  inputDraining = true
  void (async () => {
    while (inputQueue.length > 0) {
      const next = inputQueue.shift()!
      await handleRemoteInput(next).catch(() => {})
    }
    inputDraining = false
  })()
}

const THUMBNAIL_INTERVAL_MS = 4000

// Human-readable OS label for the roster's OS column -- resolved once, sent
// with every register-agent. navigator.platform is deprecated-but-stable in
// Chromium and this only needs the coarse family, not a version.
const AGENT_OS = navigator.platform.startsWith('Win')
  ? 'Windows'
  : navigator.platform.startsWith('Mac')
    ? 'macOS'
    : 'Linux'

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
  // Tracked as state (not just the effect's local `pc` variable) so
  // useVideoStats' effect re-runs when the connection is actually
  // replaced -- see the identical pattern/reasoning in ControllerSession.
  const [activePc, setActivePc] = useState<RTCPeerConnection | null>(null)
  const videoStats = useVideoStats(activePc, 'outbound')
  // Mirrors activePc for the input-helper's onDown handler below, which is
  // registered in a separate, mount-once effect (empty deps) and so can't
  // read activePc state directly without going stale -- same rationale as
  // clientRef/deviceIdRef just below.
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const [incomingRequest, setIncomingRequest] = useState(false)
  // The server rejected our saved house token (someone rotated it, or it was
  // mistyped on setup). Routes back to the token screen -- without this the
  // only fix would be hand-deleting a userData file.
  const [tokenRejected, setTokenRejected] = useState(false)
  const [pendingControllerId, setPendingControllerId] = useState<string | null>(null)
  const [trustedList, setTrustedList] = useState<{ id: string; trustedAt: number }[]>([])
  const [name, setName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const clientRef = useRef<Awaited<ReturnType<typeof connectSignaling>> | null>(null)
  const nameRef = useRef(name)
  nameRef.current = name
  const deviceIdRef = useRef(deviceId)
  deviceIdRef.current = deviceId
  // Set from the most recent connection-request's caps, read again whenever
  // this controller is (auto- or manually-) accepted -- see the
  // connection-request handler and handleAccept below.
  const controllerCapsRef = useRef<string[]>([])
  // Whether THIS session actually negotiated the input-helper path -- decided
  // once at accept time (controller supports it AND the helper is currently
  // ready) and read again when pair-result creates the session, so the
  // agent's actual behavior always matches what it told the controller in
  // connection-response.caps.
  const useHelperRef = useRef(false)
  const { transfer, attachChannel, sendFiles, rejectDrop, cancelTransfer } =
    useFileTransferChannel()

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
  // Decides, and remembers in useHelperRef, whether THIS accepted session
  // will use the input-helper path -- both sides must agree, so the caps
  // sent here in connection-response are the single source of truth that
  // pair-result later echoes back to the controller.
  async function negotiateHelperCaps(): Promise<string[]> {
    const useHelper =
      controllerCapsRef.current.includes(INPUT_HELPER_CAP) &&
      (await window.api.inputHelper.isReady())
    useHelperRef.current = useHelper
    return useHelper ? [INPUT_HELPER_CAP] : []
  }

  async function handleAccept(): Promise<void> {
    setIncomingRequest(false)
    if (pendingControllerId) {
      await window.api.trusted.trust(pendingControllerId)
      setTrustedList(await window.api.trusted.list())
    }
    setPendingControllerId(null)
    const caps = await negotiateHelperCaps()
    clientRef.current?.send({ type: 'connection-response', deviceId, accept: true, caps })
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

  // Subscribed once for the component's lifetime, not per-pairing-session --
  // the input-helper process outlives any single call and its offer/ice
  // events need relaying to whichever signaling client is current right now,
  // via clientRef/deviceIdRef rather than closing over a specific session's
  // variables. deviceId is read through a ref (not a dependency) so this
  // doesn't re-subscribe (and double-register) when identity finishes
  // loading from disk.
  useEffect(() => {
    window.api.inputHelper.onOffer((sdp) => {
      clientRef.current?.send({
        type: 'sdp-offer',
        deviceId: deviceIdRef.current ?? '',
        sdp,
        channel: 'input'
      })
    })
    window.api.inputHelper.onIce((candidate, sdpMid, sdpMLineIndex) => {
      clientRef.current?.send({
        type: 'ice-candidate',
        deviceId: deviceIdRef.current ?? '',
        candidate,
        sdpMid,
        sdpMLineIndex,
        channel: 'input'
      })
    })
    window.api.inputHelper.onDown(() => {
      // Safety net (see docs/native-input-plan.md): a helper crash used to
      // leave an active helper-backed session silently input-dead -- video
      // kept flowing, looking "connected" while nothing typed or clicked
      // ever landed, with no signal to either side that anything was wrong
      // until a human noticed and manually reconnected. Closing the video
      // pc here instead turns that into a real, visible disconnect: the
      // controller sees the connection drop and can retry the pairing,
      // which starts a genuinely fresh session (a freshly-respawned helper,
      // per inputHelperHost's own exit-handler, by the time that retry
      // reaches pair-result). Only closes anything if THIS session actually
      // used the helper path -- a helper crash during a renderer-input-
      // channel session isn't this session's problem.
      if (useHelperRef.current && pcRef.current) {
        pcRef.current.close()
        pcRef.current = null
        setActivePc(null)
        setConnectionType(null)
      }
      useHelperRef.current = false
      setStatus((current) =>
        current.startsWith('paired') || current.startsWith('connection')
          ? `${current} (input helper crashed -- reconnect to recover input)`
          : current
      )
    })
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
      // Fetched per connection attempt (not once at module load) so a token
      // corrected via the setup screen is picked up by the reload without
      // any cache to invalidate. App.tsx guarantees one exists by the time
      // this view mounts.
      const houseToken = (await window.api.houseToken.get()) ?? ''
      client = await connectSignaling(resolveSignalingUrl, {
        onDisconnect: () => setStatus('disconnected, reconnecting...'),
        onReconnect: () => {
          // The server forgets registration/pairing on disconnect, and the
          // old peer connection (if any) is no longer valid -- start over.
          pc?.close()
          pc = undefined
          pcRef.current = null
          setActivePc(null)
          void window.api.inputHelper.stopSession()
          useHelperRef.current = false
          setStatus('reconnected, registering')
          client!.send({
            type: 'register-agent',
            token: houseToken,
            deviceId: agentDeviceId,
            pin: agentPin,
            name: nameRef.current,
            os: AGENT_OS
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
          if (!message.ok && message.reason === 'invalid token') setTokenRejected(true)
        } else if (message.type === 'connection-request') {
          controllerCapsRef.current = message.caps ?? []
          if (await window.api.trusted.isTrusted(message.controllerId)) {
            const caps = await negotiateHelperCaps()
            transport.send({
              type: 'connection-response',
              deviceId: agentDeviceId,
              accept: true,
              caps
            })
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

          // Exactly one of these two paths runs per session, never both --
          // useHelperRef was decided once, at accept time, and is exactly
          // what this agent told the controller via connection-response.caps
          // (which the controller's own pair-result.caps echoes back), so
          // both sides agree on which path to expect.
          if (useHelperRef.current) {
            // Input lives entirely in the native input-helper process now --
            // stopSession() first clears out any stale PC/queue state from a
            // previous pairing before starting the fresh one.
            void window.api.inputHelper.stopSession()
            window.api.inputHelper.startSession()
            // No clipboard channel on this (renderer-owned) video pc in helper
            // mode -- clipboard sync runs inside the helper process alongside
            // input, on the helper's own pc, so it survives this window being
            // hidden to the tray (the renderer would be throttled). File
            // transfer stays here: it's driven by drag-and-drop, which needs a
            // visible window anyway.
            pc = createPeerConnection(transport, agentDeviceId, {
              createFileChannel: true,
              onFileChannel: attachChannel
            })
          } else {
            const onInputMessage = (event: MessageEvent): void => {
              enqueueRemoteInput(JSON.parse(event.data) as RemoteInputMessage)
            }
            pc = createPeerConnection(transport, agentDeviceId, {
              createInputChannel: true,
              onInputChannel: (channel) => {
                resetInputQueue() // fresh session -- controller seq restarts at 0
                channel.onmessage = onInputMessage
              },
              onMoveChannel: (channel) => {
                channel.onmessage = onInputMessage
              },
              createFileChannel: true,
              onFileChannel: attachChannel,
              onClipboardChannel: attachClipboardChannel
            })
          }
          pcRef.current = pc
          setActivePc(pc)
          pc.onconnectionstatechange = () => {
            setStatus(`connection: ${pc!.connectionState}`)
            if (pc!.connectionState === 'connected') getConnectionType(pc!).then(setConnectionType)
            else if (pc!.connectionState === 'failed' || pc!.connectionState === 'closed') {
              setConnectionType(null)
              pcRef.current = null
              setActivePc(null)
            }
          }

          // frameRate: without an explicit ask, Chromium's screen-capture
          // default can be quite conservative (sometimes ~5fps), which reads
          // as "laggy" even though the connection itself is fine. Pushed to
          // 60fps (from 30) since a smooth cursor/motion feel matters more
          // for remote *control* than per-frame sharpness -- paired with
          // capping resolution to 1080p below so the extra frames don't
          // just double the encoder's/network's workload at full native
          // resolution (which on a high-res monitor was likely the actual
          // bottleneck behind feeling laggy, not the frame rate cap itself).
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              frameRate: { ideal: 60, max: 60 },
              width: { ideal: 1920, max: 1920 },
              height: { ideal: 1080, max: 1080 }
            }
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
            // stream sooner once real available bandwidth allows it. Bumped
            // again (6Mbps -> 15Mbps) after comparing against Parsec's own
            // stats readout -- WebRTC's own congestion control still pulls
            // this down automatically if the real path can't sustain it, so
            // raising the ceiling only helps when bandwidth actually allows
            // more, never hurts otherwise.
            const params = sender.getParameters()
            if (!params.encodings?.length) params.encodings = [{}]
            params.encodings[0].maxBitrate = 15_000_000
            // Real test showed only ~25fps actually achieved despite the
            // 60fps capture request and plenty of unused bitrate headroom
            // (bitrate was sitting right at the ceiling) -- the encoder was
            // evidently choosing fewer, higher-quality frames over more
            // frequent ones. `degradationPreference` alone is only a hint
            // about what to sacrifice *under bandwidth pressure*; it
            // doesn't set an actual frame rate target. `maxFramerate` is
            // the direct way to tell the encoder what it should be aiming
            // for regardless of how much bitrate headroom it thinks it has.
            params.encodings[0].maxFramerate = 60
            // Under bandwidth pressure, WebRTC's default ('balanced') will
            // trade off *both* resolution and frame rate. For control feel,
            // a choppier-but-clear frame is worse than a softer-but-smooth
            // one -- explicitly prioritize keeping frame rate up and let
            // resolution/sharpness degrade first instead.
            params.degradationPreference = 'maintain-framerate'
            sender.setParameters(params).catch(() => {})
          })

          // Prefer H.264 over Chromium's default (often VP8, typically
          // software-encoded) -- H.264 gets hardware encode/decode on both
          // macOS (VideoToolbox) and Windows (Media Foundation) via
          // Chromium's WebRTC stack, which is the closest this
          // WebRTC-based app can get to what a native tool like Parsec
          // does with a dedicated hardware encoder. No-ops harmlessly if
          // H.264 isn't in this build's capability list.
          const videoTransceiver = pc
            .getTransceivers()
            .find((t) => t.sender.track?.kind === 'video')
          const capabilities = RTCRtpSender.getCapabilities('video')
          const h264Codecs = capabilities?.codecs.filter((c) => c.mimeType === 'video/H264') ?? []
          if (videoTransceiver && h264Codecs.length > 0 && capabilities) {
            const otherCodecs = capabilities.codecs.filter((c) => c.mimeType !== 'video/H264')
            videoTransceiver.setCodecPreferences([...h264Codecs, ...otherCodecs])
          }

          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          transport.send({
            type: 'sdp-offer',
            deviceId: agentDeviceId,
            sdp: offer.sdp,
            channel: 'video'
          })
        } else if (message.type === 'sdp-answer' && message.channel === 'input') {
          void window.api.inputHelper.remoteAnswer(message.sdp)
        } else if (message.type === 'sdp-answer' && pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        } else if (message.type === 'ice-candidate' && message.channel === 'input') {
          void window.api.inputHelper.remoteIce(
            message.candidate,
            message.sdpMid,
            message.sdpMLineIndex
          )
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
        token: houseToken,
        deviceId: agentDeviceId,
        pin: agentPin,
        name: nameRef.current,
        os: AGENT_OS
      })
    }

    start().catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clearInterval(thumbnailInterval)
      clientRef.current = null
      pc?.close()
      client?.close()
      void window.api.inputHelper.stopSession()
    }
  }, [deviceId, pin, attachChannel])

  if (tokenRejected) {
    // Full reload after saving: the signaling client and any half-open
    // session were built around the rejected token, so a clean restart of
    // this window is simpler and safer than unwinding them in place.
    return <TokenSetupView onSaved={() => window.location.reload()} />
  }
  if (deviceId === null || pin === null) {
    return (
      <div className="agent-shell">
        <p className="app-subtitle">Loading...</p>
      </div>
    )
  }

  return (
    <div className="agent-shell" onDragOver={handleDragOver} onDrop={handleDrop}>
      <TitleBar title="Personal Remote — Agent" />

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

        {videoStats && videoStats.fps > 0 && (
          <span
            className="connection-type-badge"
            title="What this machine is actually encoding and sending"
          >
            Encode {videoStats.processingMs}ms · Network {videoStats.rttMs ?? '?'}ms ·{' '}
            {videoStats.fps}fps · {videoStats.width}×{videoStats.height} ·{' '}
            {(videoStats.kbps / 1000).toFixed(1)} Mbps
            {videoStats.codec ? ` · ${videoStats.codec}` : ''}
          </span>
        )}
        {connectionType && (
          <span
            className="connection-type-badge"
            title="Affects file transfer speed -- relay is shared/bandwidth-limited"
          >
            {connectionType === 'relay' ? 'via relay' : 'direct connection'}
          </span>
        )}
        <StatusPill status={status} />

        <TransferStatus transfer={transfer} onCancel={cancelTransfer} />

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
