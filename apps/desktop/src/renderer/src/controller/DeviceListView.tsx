import { useEffect, useRef, useState } from 'react'
import { connectSignaling, SignalingClient } from '../shared/signaling/signalingClient'
import { SignalingMessage } from '../shared/protocol'
import { SIGNALING_URL } from '../shared/config'
import { getCachedPin, setCachedPin } from '../shared/devicePins'
import StatusPill from '../shared/components/StatusPill'

interface Device {
  deviceId: string
  online: boolean
}

export default function DeviceListView({
  onConnect
}: {
  onConnect: (deviceId: string, pin: string) => void
}): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([])
  const [status, setStatus] = useState('connecting to signaling server')
  const [pinPromptFor, setPinPromptFor] = useState<string | null>(null)
  const [pinInput, setPinInput] = useState('')
  const clientRef = useRef<SignalingClient | null>(null)

  useEffect(() => {
    let cancelled = false

    function applyDeviceList(list: Device[]): void {
      setDevices(list)
    }

    function applyStatusChange(deviceId: string, online: boolean): void {
      setDevices((prev) => {
        if (prev.some((d) => d.deviceId === deviceId)) {
          return prev.map((d) => (d.deviceId === deviceId ? { ...d, online } : d))
        }
        return [...prev, { deviceId, online }]
      })
    }

    connectSignaling(SIGNALING_URL, {
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
            applyStatusChange(message.deviceId, message.online)
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

  function handleConnectClick(deviceId: string): void {
    const cached = getCachedPin(deviceId)
    if (cached) {
      onConnect(deviceId, cached)
    } else {
      setPinPromptFor(deviceId)
      setPinInput('')
    }
  }

  function submitPin(): void {
    if (!pinPromptFor || !pinInput) return
    setCachedPin(pinPromptFor, pinInput)
    onConnect(pinPromptFor, pinInput)
  }

  return (
    <div className="app-shell app-shell--wide">
      <div className="app-header">
        <div className="app-icon">💻</div>
        <div>
          <div className="app-title">Computers</div>
          <div className="app-subtitle">Pick a device to connect to</div>
        </div>
      </div>

      <StatusPill status={status} />

      {devices.length === 0 ? (
        <p className="app-subtitle">No devices have registered with this server yet.</p>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <div key={device.deviceId} className="device-card">
              <div className="device-card__header">
                <span className={`status-dot-inline ${device.online ? 'is-ok' : 'is-idle'}`} />
                <span className="device-card__id">{device.deviceId}</span>
              </div>
              {pinPromptFor === device.deviceId ? (
                <div className="device-card__pin-prompt">
                  <input
                    className="field-input"
                    placeholder="PIN"
                    value={pinInput}
                    autoFocus
                    onChange={(e) => setPinInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitPin()}
                  />
                  <button className="btn" onClick={submitPin}>
                    Go
                  </button>
                </div>
              ) : (
                <button
                  className="btn"
                  disabled={!device.online}
                  onClick={() => handleConnectClick(device.deviceId)}
                >
                  Connect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
