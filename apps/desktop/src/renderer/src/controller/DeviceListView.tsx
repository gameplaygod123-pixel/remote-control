import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { resolveSignalingUrl } from '../shared/signaling/resolveSignalingUrl'
import { SignalingMessage } from '../shared/protocol'
import { classify } from '../shared/components/StatusPill'
import UpdateBadge from '../shared/components/UpdateBadge'
import SwitchModeLink from '../shared/components/SwitchModeLink'
import '../assets/deviceList.css'

interface Device {
  deviceId: string
  online: boolean
  name?: string
  thumbnail?: string
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('th-TH', { hour12: false })
}

// The image-1 mockup shows every card with the same small monitor icon as a
// placeholder (colored by online/offline) rather than text -- shown until a
// real thumbnail arrives, or permanently for offline devices.
function MonitorIcon(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8" y="8" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

export default function DeviceListView({
  onConnect
}: {
  onConnect: (deviceId: string, pin: string, name?: string) => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [status, setStatus] = useState('connecting to signaling server')
  const [pinPromptFor, setPinPromptFor] = useState<string | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  // Manual entry -- connects straight to a Device ID/PIN without waiting
  // for it to show up in the auto-discovered list. Needed for a device
  // that hasn't registered with this signaling server yet, is on a
  // different signaling server entirely, or just hasn't shown up for any
  // other reason -- a correct ID+PIN is enough to try pairing regardless.
  const [showAddDevice, setShowAddDevice] = useState(false)
  const [addDeviceId, setAddDeviceId] = useState('')
  const [addPin, setAddPin] = useState('')
  const clientRef = useRef<SignalingClient | null>(null)

  useEffect(() => {
    let cancelled = false

    function applyDeviceList(list: Device[]): void {
      setDevices(list)
      setLastUpdated(new Date())
    }

    function applyStatusChange(deviceId: string, online: boolean, name?: string): void {
      setDevices((prev) => {
        if (prev.some((d) => d.deviceId === deviceId)) {
          return prev.map((d) => (d.deviceId === deviceId ? { ...d, online, name } : d))
        }
        return [...prev, { deviceId, online, name }]
      })
      setLastUpdated(new Date())
    }

    function applyThumbnail(deviceId: string, thumbnail: string): void {
      setDevices((prev) => prev.map((d) => (d.deviceId === deviceId ? { ...d, thumbnail } : d)))
      setLastUpdated(new Date())
    }

    function applyRemoval(deviceId: string): void {
      setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId))
      setLastUpdated(new Date())
    }

    connectSignaling(resolveSignalingUrl, {
      onDisconnect: () => setStatus('disconnected, reconnecting...'),
      onReconnect: () => {
        setStatus('reconnected')
        clientRef.current?.send({ type: 'list-devices' })
      }
    })
      .then((client) => {
        if (cancelled) {
          client.close()
          return
        }
        clientRef.current = client
        setStatus('connected')

        client.onMessage((raw) => {
          const parsed = SignalingMessage.safeParse(raw)
          if (!parsed.success) return
          const message = parsed.data
          if (message.type === 'device-list') applyDeviceList(message.devices)
          else if (message.type === 'device-status-changed') {
            applyStatusChange(message.deviceId, message.online, message.name)
          } else if (message.type === 'device-thumbnail') {
            applyThumbnail(message.deviceId, message.image)
          } else if (message.type === 'device-removed') {
            applyRemoval(message.deviceId)
          }
        })

        client.send({ type: 'list-devices' })
      })
      .catch((error) => setStatus(`error: ${String(error)}`))

    return () => {
      cancelled = true
      clientRef.current?.close()
    }
  }, [])

  async function handleConnectClick(deviceId: string, name?: string): Promise<void> {
    const cached = await window.api.controllerMemory.getCachedPin(deviceId)
    if (cached) {
      onConnect(deviceId, cached, name)
    } else {
      setPinPromptFor(deviceId)
      setPinInput('')
    }
  }

  async function submitPin(name?: string): Promise<void> {
    if (!pinPromptFor || !pinInput) return
    await window.api.controllerMemory.setCachedPin(pinPromptFor, pinInput)
    onConnect(pinPromptFor, pinInput, name)
  }

  // Offline-only, matching the server's guard (removeDevice ignores the
  // request for a currently-online device) -- a device that's still
  // reachable shouldn't disappear just because someone clicked cleanup.
  function handleRemoveDevice(deviceId: string): void {
    clientRef.current?.send({ type: 'remove-device', deviceId })
  }

  async function submitAddDevice(): Promise<void> {
    const deviceId = addDeviceId.trim()
    const pin = addPin.trim()
    if (!deviceId || !pin) return
    await window.api.controllerMemory.setCachedPin(deviceId, pin)
    onConnect(deviceId, pin)
  }

  const onlineCount = devices.filter((d) => d.online).length
  const statusVariant = classify(status)

  return (
    <div className="dl-shell">
      <div className="dl-titlebar">
        <div className="dl-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="dl-titletext">Personal Remote — Computers</div>
      </div>

      <div className="dl-body">
        <div className="dl-header">
          <div>
            <h1 className="dl-heading">
              Computers<span className="dl-cursor">_</span>
            </h1>
            <p className="dl-subheading">พบเครื่องทั้งหมด {devices.length} เครื่อง</p>
          </div>
          <div className="dl-header-actions">
            <span className={`dl-pill is-${statusVariant}`}>
              <span className={`dl-pill-dot${statusVariant === 'warn' ? ' is-pulsing' : ''}`} />
              {status}
            </span>
            <button className="dl-add-toggle" onClick={() => setShowAddDevice((v) => !v)}>
              {showAddDevice ? '✕ Cancel' : '+ Add device'}
            </button>
          </div>
        </div>

        {showAddDevice && (
          <div className="dl-add-card">
            <input
              className="dl-pin-input"
              placeholder="Device ID"
              value={addDeviceId}
              autoFocus
              onChange={(e) => setAddDeviceId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAddDevice()}
            />
            <input
              className="dl-pin-input"
              placeholder="PIN"
              value={addPin}
              onChange={(e) => setAddPin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAddDevice()}
            />
            <button
              className="dl-btn"
              style={{ width: 'auto', padding: '0 14px' }}
              disabled={!addDeviceId.trim() || !addPin.trim()}
              onClick={submitAddDevice}
            >
              Connect
            </button>
          </div>
        )}

        {devices.length === 0 ? (
          <p className="dl-empty">No devices have registered with this server yet.</p>
        ) : (
          <div className="dl-grid">
            {devices.map((device) => (
              <div key={device.deviceId} className="dl-card">
                <div className={`dl-thumb ${device.online ? '' : 'is-offline'}`}>
                  {device.thumbnail ? <img src={device.thumbnail} alt="" /> : <MonitorIcon />}
                </div>
                <div>
                  <div className="dl-name">{device.name || device.deviceId}</div>
                  {device.name && <div className="dl-id">{device.deviceId}</div>}
                </div>
                <div className={`dl-status-row ${device.online ? 'is-ok' : ''}`}>
                  <span className={`dl-status-dot ${device.online ? 'is-ok' : 'is-idle'}`} />
                  {device.online ? 'online' : 'offline'}
                </div>
                {pinPromptFor === device.deviceId ? (
                  <div className="dl-pin-prompt">
                    <input
                      className="dl-pin-input"
                      placeholder="PIN"
                      value={pinInput}
                      autoFocus
                      onChange={(e) => setPinInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && submitPin(device.name)}
                    />
                    <button
                      className="dl-btn"
                      style={{ width: 'auto', padding: '0 14px' }}
                      onClick={() => submitPin(device.name)}
                    >
                      Go
                    </button>
                  </div>
                ) : (
                  <button
                    className="dl-btn"
                    disabled={!device.online}
                    onClick={() => handleConnectClick(device.deviceId, device.name)}
                  >
                    Connect
                  </button>
                )}
                {!device.online && pinPromptFor !== device.deviceId && (
                  <button
                    className="dl-card__remove"
                    onClick={() => handleRemoveDevice(device.deviceId)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dl-footer">
        <div className="dl-footer-group">
          <span>
            online: {onlineCount} · offline: {devices.length - onlineCount}
          </span>
          <SwitchModeLink />
        </div>
        <div className="dl-footer-group">
          <UpdateBadge />
          <span>{lastUpdated ? `อัปเดตล่าสุด ${formatTime(lastUpdated)}` : ''}</span>
        </div>
      </div>
    </div>
  )
}
