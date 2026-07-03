import { useState } from 'react'
import DeviceListView from './DeviceListView'
import ControllerSession from './ControllerSession'
import { AUTO_CONNECT_DEVICE_ID, FIXED_PIN } from '../shared/config'

interface ActiveDevice {
  deviceId: string
  pin: string
}

// If VITE_DEVICE_ID/VITE_PIN are set (the single-device launcher scripts),
// skip the device list entirely and connect straight away, preserving the
// old zero-click behavior for a one-agent setup.
const AUTO_CONNECT: ActiveDevice | null =
  AUTO_CONNECT_DEVICE_ID && FIXED_PIN ? { deviceId: AUTO_CONNECT_DEVICE_ID, pin: FIXED_PIN } : null

function ControllerView(): React.JSX.Element {
  const [activeDevice, setActiveDevice] = useState<ActiveDevice | null>(AUTO_CONNECT)

  if (activeDevice) {
    return (
      <ControllerSession
        deviceId={activeDevice.deviceId}
        pin={activeDevice.pin}
        onBack={() => setActiveDevice(null)}
      />
    )
  }

  return <DeviceListView onConnect={(deviceId, pin) => setActiveDevice({ deviceId, pin })} />
}

export default ControllerView
