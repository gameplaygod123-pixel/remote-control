import { useState } from 'react'
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
// old zero-click behavior for a one-agent setup. This is an explicit,
// opt-in dev/launcher-script mechanism -- unlike the auto-connect-to-last-
// device behavior this file used to also have, which silently jumped
// straight into a fullscreened session on every launch with no way to
// land on the device list first. Removed after that turned out to be the
// opposite of what was wanted in practice.
const ENV_AUTO_CONNECT: ActiveDevice | null =
  AUTO_CONNECT_DEVICE_ID && FIXED_PIN ? { deviceId: AUTO_CONNECT_DEVICE_ID, pin: FIXED_PIN } : null

function ControllerView(): React.JSX.Element {
  const [activeDevice, setActiveDevice] = useState<ActiveDevice | null>(ENV_AUTO_CONNECT)

  function handleConnect(deviceId: string, pin: string, name?: string): void {
    window.api.controllerMemory.setLastDeviceId(deviceId)
    setActiveDevice({ deviceId, pin, name })
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
