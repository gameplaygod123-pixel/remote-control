import { useEffect, useState } from 'react'
import DeviceListView from './DeviceListView'
import ControllerSession from './ControllerSession'
import { AUTO_CONNECT_DEVICE_ID, FIXED_PIN } from '../shared/config'

interface ActiveDevice {
  deviceId: string
  pin: string
  name?: string
}

// If VITE_DEVICE_ID/VITE_PIN are set (the single-device launcher scripts),
// skip the device list entirely and connect straight away, preserving the
// old zero-click behavior for a one-agent setup.
const ENV_AUTO_CONNECT: ActiveDevice | null =
  AUTO_CONNECT_DEVICE_ID && FIXED_PIN ? { deviceId: AUTO_CONNECT_DEVICE_ID, pin: FIXED_PIN } : null

function ControllerView(): React.JSX.Element {
  const [activeDevice, setActiveDevice] = useState<ActiveDevice | null>(ENV_AUTO_CONNECT)
  // Avoids a flash of the device list before the last-connected-device
  // check (an IPC round-trip) resolves.
  const [checkedLastDevice, setCheckedLastDevice] = useState(!!ENV_AUTO_CONNECT)

  useEffect(() => {
    if (ENV_AUTO_CONNECT) return
    window.api.controllerMemory.getLastDevice().then((last) => {
      setActiveDevice(last)
      setCheckedLastDevice(true)
    })
  }, [])

  function handleConnect(deviceId: string, pin: string, name?: string): void {
    window.api.controllerMemory.setLastDeviceId(deviceId)
    setActiveDevice({ deviceId, pin, name })
  }

  if (!checkedLastDevice) {
    return (
      <div className="app-shell">
        <p className="app-subtitle">Loading...</p>
      </div>
    )
  }

  if (activeDevice) {
    return (
      <ControllerSession
        deviceId={activeDevice.deviceId}
        pin={activeDevice.pin}
        name={activeDevice.name}
        onBack={() => setActiveDevice(null)}
      />
    )
  }

  return <DeviceListView onConnect={handleConnect} />
}

export default ControllerView
